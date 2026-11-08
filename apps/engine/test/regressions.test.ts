import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { DEFAULT_POLICY, evaluate, type GuardContext } from '../src/guard/policy.ts';
import { WEB_PAGE_CSP } from '../src/http/security.ts';
import { enrolledUser, makeEngine, type TestEngine } from './helpers.ts';

let t: TestEngine;
beforeAll(async () => {
  t = await makeEngine();
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

describe('web pages can actually load', () => {
  test('/setup and /a/:id get a CSP that allows the app bundle', async () => {
    const setup = await t.engine.app.request('/setup');
    // The build may be absent in a bare checkout; the header is what regressed.
    if (setup.status === 200) {
      const csp = setup.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).not.toBe("default-src 'none'; frame-ancestors 'none'");
    }
    const page = await t.engine.app.request('/a/apr_01J0000000000000000000000');
    if (page.status === 200) {
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    }
  });

  test('API routes keep the strict no-script policy', async () => {
    const r = await t.engine.app.request('/healthz');
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
  });

  test('the page CSP still forbids inline script and framing', () => {
    expect(WEB_PAGE_CSP).not.toContain("'unsafe-inline'");
    expect(WEB_PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_PAGE_CSP).toContain("base-uri 'none'");
  });
});

describe('guard decision ordering', () => {
  const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
    now: new Date('2026-11-05T19:00:00Z'),
    spentLast24hMicros: 0n,
    knownRecipients: new Set(['ada.penny.near']),
    approvalsLast10Min: 0,
    ...over,
  });

  test('an unpriced NEAR send that is also over the cap reports block, not needs_more_info', () => {
    // No nearUsdPriceMicros: usdMicros() returns null. The amount is over the
    // per-tx cap, so the block reason must win.
    const r = evaluate(
      { kind: 'send', asset: 'NEAR', amount: '1000', to: 'ada.penny.near' },
      DEFAULT_POLICY,
      ctx(),
    );
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).not.toContain('fresh NEAR price');
  });

  test('an unpriced NEAR send with no other problem still asks for a price', () => {
    const r = evaluate(
      { kind: 'send', asset: 'NEAR', amount: '1', to: 'ada.penny.near' },
      DEFAULT_POLICY,
      ctx(),
    );
    expect(r.decision).toBe('needs_more_info');
    expect(r.reasons.join(' ')).toContain('fresh NEAR price');
  });

  test('a disallowed asset is blocked even when the price is missing', () => {
    const r = evaluate(
      { kind: 'send', asset: 'NEAR', amount: '1', to: 'ada.penny.near' },
      DEFAULT_POLICY,
      ctx({ assetWhitelist: ['USDC'] }),
    );
    expect(r.decision).toBe('block');
  });
});

describe('sweepers do not leak ledger reservations', () => {
  test('expired approvals are swept oldest-first so none starve past the limit', async () => {
    const u = await enrolledUser(t, '+15559001');
    const svc = t.engine.services.approvals;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await svc.createMoneyApproval({
        userId: u.userId,
        bot: null,
        plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
        space: u.space,
      });
      if (r.decision !== 'allow_with_approval') throw new Error('expected a card');
      ids.push(r.approvalId);
      // Each card expires 2 minutes after the last, so ordering is observable.
      t.clock.now = new Date(t.clock.now.getTime() + 120_000);
    }
    // Move the clock past every expiry.
    t.clock.now = new Date(t.clock.now.getTime() + 10 * 60_000);
    const due = await t.engine.repos.approvals.pendingExpiredBefore(t.clock.now);
    const dueIds = due.map((r) => r.id).filter((id) => ids.includes(id));
    // Oldest expiry first: the first card created is the first swept.
    expect(dueIds[0]).toBe(ids[0] as string);

    const swept = await svc.expireDue();
    expect(swept).toBeGreaterThanOrEqual(3);
    for (const id of ids) {
      const row = await t.engine.repos.approvals.get(id);
      expect(row?.status).toBe('expired');
    }
    const held = (await t.db.db.execute(
      sql`select count(*)::int as n from ledger_entries where status = 'reserved' and approval_id in (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    )) as unknown as { rows: { n: number }[] };
    expect(held.rows[0]?.n).toBe(0);
  });

  test('an approval stuck in signed is failed and its reservation released', async () => {
    const u = await enrolledUser(t, '+15559002');
    const svc = t.engine.services.approvals;
    const r = await svc.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '2', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected a card');
    // Simulate "signature verified, relay never reported back".
    await t.engine.repos.approvals.transition(
      r.approvalId,
      'send',
      'pending',
      'signed',
      'delegate action verified',
    );
    t.clock.now = new Date(t.clock.now.getTime() + 20 * 60_000);
    const fixed = await svc.reconcileStuckSigned();
    expect(fixed).toBeGreaterThanOrEqual(1);
    const row = await t.engine.repos.approvals.get(r.approvalId);
    expect(row?.status).toBe('failed');
    const held = (await t.db.db.execute(
      sql`select count(*)::int as n from ledger_entries where status = 'reserved' and approval_id = ${r.approvalId}`,
    )) as unknown as { rows: { n: number }[] };
    expect(held.rows[0]?.n).toBe(0);
  });

  test('a fresh signed row is left alone', async () => {
    const u = await enrolledUser(t, '+15559003');
    const svc = t.engine.services.approvals;
    const r = await svc.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '3', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected a card');
    await t.engine.repos.approvals.transition(
      r.approvalId,
      'send',
      'pending',
      'signed',
      'delegate action verified',
    );
    await svc.reconcileStuckSigned();
    const row = await t.engine.repos.approvals.get(r.approvalId);
    expect(row?.status).toBe('signed');
  });
});

describe('velocity counts only live approvals', () => {
  test('declined cards do not lock the user out of the next one', async () => {
    const u = await enrolledUser(t, '+15559004');
    const svc = t.engine.services.approvals;
    const policy = await t.engine.repos.users.policy(u.userId);
    // maxApprovalsPer10Min is 5 by default; decline 5 cards.
    for (let i = 0; i < policy.maxApprovalsPer10Min; i++) {
      const r = await svc.createMoneyApproval({
        userId: u.userId,
        bot: null,
        plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
        space: u.space,
      });
      if (r.decision !== 'allow_with_approval') throw new Error('expected a card');
      await svc.decline(r.approvalId, r.cardToken);
    }
    const next = await svc.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: u.space,
    });
    expect(next.decision).toBe('allow_with_approval');
  });
});

describe('card handles survive a restart', () => {
  test('the handle is persisted and a fresh service can still edit the card', async () => {
    const u = await enrolledUser(t, '+15559005');
    const svc = t.engine.services.approvals;
    const r = await svc.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '4', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected a card');
    const row = await t.engine.repos.approvals.get(r.approvalId);
    expect(row?.cardRef).toBeTruthy();
    expect(row?.cardSpace?.spaceId).toBe(u.space.spaceId);

    // A rebuilt engine has an empty in-process map but the same database.
    t.setModels(
      (await import('./helpers.ts')).scriptedModel([{ text: '' }]),
      (await import('./helpers.ts')).scriptedModel([{ text: 'ok' }]),
    );
    const editsBefore = t.messaging.edits.length;
    await t.engine.services.approvals.decline(r.approvalId, r.cardToken);
    expect(t.messaging.edits.length).toBeGreaterThan(editsBefore);
    expect(t.messaging.edits.at(-1)?.card.subcaption).toContain('nothing moved');
  });
});
