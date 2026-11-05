import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import {
  BLOCKED_WRITE_RESULT,
  FakeConnector,
  gateComposioTools,
  writeSlugIn,
} from '../src/connectors/composio.ts';
import { enrolledUser, makeEngine, scriptedModel, type TestEngine } from './helpers.ts';

describe('writeSlugIn', () => {
  test('detects write slugs in names and in meta-tool arguments', () => {
    expect(writeSlugIn('GMAIL_SEND_EMAIL')).toBe('GMAIL_SEND_EMAIL');
    expect(writeSlugIn('GMAIL_FETCH_EMAILS')).toBeNull();
    expect(writeSlugIn({ tools: [{ tool_slug: 'GITHUB_CREATE_ISSUE', arguments: {} }] })).toBe(
      'GITHUB_CREATE_ISSUE',
    );
    expect(
      writeSlugIn({ tools: [{ tool_slug: 'GMAIL_LIST_MESSAGES', arguments: {} }] }),
    ).toBeNull();
    expect(writeSlugIn('COMPOSIO_SEARCH_TOOLS')).toBeNull();
  });
});

describe('gateComposioTools', () => {
  const make = () => {
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
      COMPOSIO_MULTI_EXECUTE_TOOL: tool({
        description: 'meta',
        inputSchema: z.object({ tools: z.array(z.unknown()) }).passthrough(),
        execute: async () => {
          executed += 1;
          return { ok: true };
        },
      }),
    } as ToolSet);
    return { tools, executed: () => executed };
  };

  test('read tools execute, direct and meta write tools are blocked, sandbox removed', async () => {
    const { tools, executed } = make();
    const read = tools.GMAIL_FETCH_EMAILS as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    expect(await read.execute({}, {})).toEqual({ emails: [] });

    const write = tools.GMAIL_SEND_EMAIL as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    expect(await write.execute({}, {})).toEqual({ ...BLOCKED_WRITE_RESULT });

    const meta = tools.COMPOSIO_MULTI_EXECUTE_TOOL as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    expect(
      await meta.execute({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }] }, {}),
    ).toEqual({ ...BLOCKED_WRITE_RESULT });
    expect(
      await meta.execute({ tools: [{ tool_slug: 'GMAIL_LIST_MESSAGES', arguments: {} }] }, {}),
    ).toEqual({ ok: true });
    expect(executed()).toBe(2);
  });
});

describe('crew with FakeConnector', () => {
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

  test('mail bot searches connected mail through the crew tool loop', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'mail', reason: 'bill question' } }]),
      scriptedModel([
        { tool: 'fake_search_mail', input: { query: 'bill' } },
        { text: 'IKEDC bill: 18400, due Friday.' },
      ]),
    );
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'any bills?');
    expect(r.botSlug).toBe('mail');
    expect(r.toolCalls).toContain('fake_search_mail');
    expect(fake.searched).toEqual(['bill']);
    expect(r.text).toContain('IKEDC');
  });
});
