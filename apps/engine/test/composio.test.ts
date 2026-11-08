import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { planApprovalMessage } from '@penny/shared';
import type { ToolSet } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import { writeFacts } from '../src/approvals/write-facts.ts';
import {
  blockedSlugIn,
  blockedWriteResult,
  FakeConnector,
  gateComposioTools,
  isReadSlug,
  toolkitsForBot,
  writeTargetProblem,
} from '../src/connectors/composio.ts';
import { enrolledUser, makeEngine, scriptedModel, type TestEngine } from './helpers.ts';

describe('write targets', () => {
  test('only real writes in a toolkit the bot may use are approvable', () => {
    expect(writeTargetProblem('gmail', 'GMAIL_SEND_EMAIL', 'mail')).toBeNull();
    expect(writeTargetProblem('github', 'GITHUB_CREATE_ISSUE', 'penny')).toBeNull();
    // card App and executed slug must agree
    expect(writeTargetProblem('github', 'GMAIL_SEND_EMAIL', 'penny')).toContain('does not belong');
    // meta + sandbox tools are never approvable
    expect(writeTargetProblem('composio', 'COMPOSIO_REMOTE_BASH_TOOL')).not.toBeNull();
    expect(writeTargetProblem('gmail', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'mail')).not.toBeNull();
    // reads are not writes; bots without connectors cannot propose
    expect(writeTargetProblem('gmail', 'GMAIL_FETCH_EMAILS', 'mail')).toBe('not a write action');
    expect(writeTargetProblem('gmail', 'GMAIL_SEND_EMAIL', 'invest')).toContain('not enabled');
    expect(writeTargetProblem('github', 'GITHUB_CREATE_ISSUE', 'mail')).toContain('not enabled');
    expect(writeTargetProblem('slack', 'SLACK_SEND_MESSAGE')).toContain('not enabled');
  });
  test('FakeConnector.executeWrite refuses sandbox and mismatched targets', async () => {
    const f = new FakeConnector();
    await expect(
      f.executeWrite('u', 'composio', 'COMPOSIO_REMOTE_BASH_TOOL', {}),
    ).rejects.toThrow();
    await expect(f.executeWrite('u', 'github', 'GMAIL_SEND_EMAIL', {})).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });
  test('card facts come from the arguments that will be sent', () => {
    const facts = writeFacts({
      kind: 'write',
      toolkit: 'gmail',
      toolSlug: 'GMAIL_SEND_EMAIL',
      title: 'Reply',
      summary: 'A harmless reply',
      arguments: {
        body: 'line one\nline two\u202e',
        recipient_email: 'attacker@evil.example',
        subject: 'Re: rent',
      },
    });
    expect(facts).toEqual([
      { label: 'App', value: 'gmail' },
      { label: 'Action', value: 'GMAIL_SEND_EMAIL' },
      { label: 'recipient_email', value: 'attacker@evil.example' },
      { label: 'subject', value: 'Re: rent' },
      { label: 'body', value: 'line one line two' },
      { label: "Penny's note", value: 'A harmless reply' },
    ]);
  });
});

describe('fail-closed gate classification', () => {
  test('only known read verbs run freely', () => {
    expect(isReadSlug('GMAIL_FETCH_EMAILS')).toBe(true);
    expect(isReadSlug('GMAIL_GET_PROFILE')).toBe(true);
    expect(isReadSlug('GITHUB_LIST_REPOSITORY_ISSUES')).toBe(true);
    expect(isReadSlug('GMAIL_SEND_EMAIL')).toBe(false);
    expect(isReadSlug('GITHUB_CREATE_ISSUE')).toBe(false);
    expect(isReadSlug('GMAIL_MODIFY_MESSAGE')).toBe(false);
    expect(isReadSlug('SOME_FUTURE_TOOL')).toBe(false);
    expect(isReadSlug('GMAIL_FETCH_AND_DELETE')).toBe(false);
  });
  test('toolkit scoping is explicit, never unscoped', () => {
    expect(toolkitsForBot('mail')).toEqual(['gmail']);
    expect(toolkitsForBot('invest')).toBeNull();
    expect(toolkitsForBot('guard')).toBeNull();
    expect(toolkitsForBot('custom-x')).toEqual(['gmail', 'github']);
  });
  test('blockedSlugIn inspects meta-tool arguments, allows meta allowlist', () => {
    expect(
      blockedSlugIn('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] }),
    ).toBe('GMAIL_SEND_EMAIL');
    expect(
      blockedSlugIn('COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }],
      }),
    ).toBeNull();
    expect(blockedSlugIn('COMPOSIO_SEARCH_TOOLS', { query: 'send email' })).toBeNull();
    expect(blockedSlugIn('GMAIL_SEND_EMAIL', {})).toBe('GMAIL_SEND_EMAIL');
  });
});

describe('gateComposioTools', () => {
  test('read executes; writes blocked with slug; unknown tools blocked; sandbox removed', async () => {
    let executed = 0;
    const tools = gateComposioTools({
      GMAIL_FETCH_EMAILS: tool({
        description: 'read',
        inputSchema: z.object({}).strict(),
        execute: async () => {
          executed += 1;
          return { emails: [] };
        },
      }),
      GMAIL_SEND_EMAIL: tool({
        description: 'write',
        inputSchema: z.object({}).strict(),
        execute: async () => {
          executed += 1;
          return { sent: true };
        },
      }),
      COMPOSIO_REMOTE_BASH_TOOL: tool({
        description: 'sandbox',
        inputSchema: z.object({}).strict(),
        execute: async () => ({ ok: true }),
      }),
    } as ToolSet);
    expect(tools.COMPOSIO_REMOTE_BASH_TOOL).toBeUndefined();
    type Ex = { execute: (a: unknown, o: unknown) => Promise<unknown> };
    expect(await (tools.GMAIL_FETCH_EMAILS as Ex).execute({}, {})).toEqual({ emails: [] });
    expect(await (tools.GMAIL_SEND_EMAIL as Ex).execute({}, {})).toEqual(
      blockedWriteResult('GMAIL_SEND_EMAIL'),
    );
    expect(executed).toBe(1);
  });
});

describe('connect flow + write approvals through the crew', () => {
  let t: TestEngine;
  let u: Awaited<ReturnType<typeof enrolledUser>>;
  const fake = new FakeConnector();
  beforeAll(async () => {
    t = await makeEngine({ connectors: fake });
    u = await enrolledUser(t);
  }, 120_000);
  afterAll(async () => {
    await t?.db.close();
  });

  test('connect_app returns a link first, then connected', async () => {
    const first = await fake.connect(u.userId, 'gmail');
    expect(first.status).toBe('link');
    const second = await fake.connect(u.userId, 'gmail');
    expect(second.status).toBe('connected');
  });

  test('find_bills returns parsed bills from connected Gmail', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'mail', reason: 'bills' } }]),
      scriptedModel([
        { tool: 'find_bills', input: {} },
        { text: 'IKEDC bill: ₦18,400, due Friday.' },
      ]),
    );
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'any bills?');
    expect(r.botSlug).toBe('mail');
    expect(r.toolCalls).toContain('find_bills');
    expect(fake.searched.some((q) => q.includes('subject:('))).toBe(true);
  });

  test('write runs only after device-signed approval, exactly once', async () => {
    const mail = await t.engine.repos.bots.builtIn('mail');
    const created = await t.engine.services.approvals.createWriteApproval({
      userId: u.userId,
      bot: mail,
      plan: {
        kind: 'write',
        toolkit: 'gmail',
        toolSlug: 'GMAIL_SEND_EMAIL',
        title: 'Send reply to landlord',
        summary: 'Reply confirming Friday payment',
        arguments: {
          recipient_email: 'landlord@example.com',
          subject: 'Re: rent',
          body: 'Friday works.',
        },
      },
      space: u.space,
    });
    expect(created.decision).toBe('allow_with_approval');
    if (created.decision !== 'allow_with_approval') throw new Error('no approval');
    expect(fake.writes).toHaveLength(0);

    const row = await t.engine.repos.approvals.get(created.approvalId);
    if (!row) throw new Error('approval missing');
    const sig = u.keys.sign(planApprovalMessage(row.id, row.planHash));
    const submitted = await t.engine.services.approvals.submit(
      created.approvalId,
      created.cardToken,
      {
        planSignature: sig,
      },
    );
    expect(submitted.status).toBe('settled');
    expect(fake.writes).toEqual([
      {
        slug: 'GMAIL_SEND_EMAIL',
        args: {
          recipient_email: 'landlord@example.com',
          subject: 'Re: rent',
          body: 'Friday works.',
        },
      },
    ]);
    // single-use: resubmit is rejected, no second execution
    await expect(
      t.engine.services.approvals.submit(created.approvalId, created.cardToken, {
        planSignature: sig,
      }),
    ).rejects.toMatchObject({ code: 'not_pending' });
    expect(fake.writes).toHaveLength(1);
    const status = await t.engine.services.approvals.status(created.approvalId, created.cardToken);
    expect(status.steps.map((s) => s.label)).toContain('Done in the app');
  });

  test('mismatched write target is blocked before any card', async () => {
    const mail = await t.engine.repos.bots.builtIn('mail');
    const created = await t.engine.services.approvals.createWriteApproval({
      userId: u.userId,
      bot: mail,
      plan: {
        kind: 'write',
        toolkit: 'github',
        toolSlug: 'GMAIL_SEND_EMAIL',
        title: 'Open issue',
        summary: 'Looks like a GitHub issue',
        arguments: { recipient_email: 'x@y.z', subject: 's', body: 'b' },
      },
      space: u.space,
    });
    expect(created.decision).toBe('block');
    expect(fake.writes).toHaveLength(1); // only the approved one from above
  });

  test('declined write never executes', async () => {
    const mail = await t.engine.repos.bots.builtIn('mail');
    const created = await t.engine.services.approvals.createWriteApproval({
      userId: u.userId,
      bot: mail,
      plan: {
        kind: 'write',
        toolkit: 'gmail',
        toolSlug: 'GMAIL_SEND_EMAIL',
        title: 'Send newsletter',
        summary: 'Monthly update',
        arguments: { recipient_email: 'a@b.c', subject: 'hi', body: 'x' },
      },
      space: u.space,
    });
    if (created.decision !== 'allow_with_approval') throw new Error('no approval');
    await t.engine.services.approvals.decline(created.approvalId, created.cardToken);
    expect(fake.writes).toHaveLength(1); // still only the approved one
  });
});
