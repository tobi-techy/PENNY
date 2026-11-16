import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createRegistry } from '../src/brain/tools.ts';
import { approvals, cards, fundingQuotes } from '../src/db/schema.ts';
import { FakeFunding } from '../src/market/funding.ts';
import { enrolledUser, makeEngine, type TestEngine } from './helpers.ts';

/**
 * Adding money from another chain: an address that only receives, a copyable
 * text, and a poller that tells the user once when the dollars land.
 */
let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;
let fake: FakeFunding;

beforeAll(async () => {
  fake = new FakeFunding(() => t.clock.now);
  t = await makeEngine({ extra: { funding: fake } });
  u = await enrolledUser(t);
  await t.engine.repos.users.conversationFor(u.userId, u.space.spaceId, 'imessage', '+15550100');
}, 120_000);

afterAll(async () => {
  await t?.db.close();
});

async function rows(userId: string) {
  return t.db.db.select().from(fundingQuotes).where(eq(fundingQuotes.userId, userId));
}

async function fundCards(userId: string) {
  return t.db.db
    .select()
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.type, 'fund')));
}

describe('adding money from another chain', () => {
  test('gives an address, a card and a copyable text; no approval', async () => {
    const before = t.messaging.edits.length;
    const r = await t.engine.services.funding.start({
      userId: u.userId,
      space: u.space,
      amountUsd: '20',
      chain: 'base',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.depositAddress).toBe('deposit-base-1');
    expect(r.chain).toBe('base');

    const sent = await fundCards(u.userId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.state).toBe('ready'); // an instruction, not a landing
    expect(sent[0]?.amount).toBe('$20.00');
    expect(sent[0]?.lines[0]?.value).toBe('20 USDC on Base');

    const text = t.messaging.texts.at(-1)?.text ?? '';
    expect(text).toContain('send exactly 20 USDC on Base');
    expect(text).toContain('deposit-base-1');
    expect(text).toContain("i'll text you when it lands");

    const stored = await rows(u.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe('open');
    expect(stored[0]?.amountIn).toBe('20000000');

    // An address that only receives is not an approval; nothing needs Face ID.
    const aprs = await t.db.db.select().from(approvals).where(eq(approvals.userId, u.userId));
    expect(aprs).toHaveLength(0);
    expect(t.messaging.edits.length).toBe(before);
  });

  test('polling follows the deposit to a landed card, and says it once', async () => {
    const r = await t.engine.services.funding.start({
      userId: u.userId,
      space: u.space,
      amountUsd: '12',
      chain: 'solana',
    });
    if (!r.ok) throw new Error('start failed');
    fake.statuses.set(r.depositAddress, 'PROCESSING');
    await t.engine.services.funding.poll(t.clock.now);
    const midway = (await rows(u.userId)).find((x) => x.depositAddress === r.depositAddress);
    expect(midway?.state).toBe('processing');

    fake.statuses.set(r.depositAddress, 'SUCCESS');
    expect(await t.engine.services.funding.poll(t.clock.now)).toBe(1);
    const done = (await rows(u.userId)).find((x) => x.depositAddress === r.depositAddress);
    expect(done?.state).toBe('success');
    expect(done?.amountOutDisplay).toBe('19.94 USDC');
    const card = (await fundCards(u.userId)).find((c) => c.id === done?.cardId);
    expect(card?.state).toBe('done');
    const text = t.messaging.texts.at(-1)?.text ?? '';
    expect(text).toContain('your $12.00 landed');
    expect(text).toContain('19.94 USDC');

    // A second poll must not repeat the message.
    const textsAfterLanding = t.messaging.texts.length;
    await t.engine.services.funding.poll(t.clock.now);
    expect(t.messaging.texts.length).toBe(textsAfterLanding);
  });

  test('a refund comes back into their own account, and a failure takes nothing', async () => {
    const a = await t.engine.services.funding.start({
      userId: u.userId,
      space: u.space,
      amountUsd: '8',
      chain: 'ethereum',
    });
    if (!a.ok) throw new Error('start failed');
    fake.statuses.set(a.depositAddress, 'REFUNDED');
    await t.engine.services.funding.poll(t.clock.now);
    expect((await rows(u.userId)).find((x) => x.depositAddress === a.depositAddress)?.state).toBe(
      'refunded',
    );
    expect(t.messaging.texts.at(-1)?.text).toContain('came back as a refund');

    const b = await t.engine.services.funding.start({
      userId: u.userId,
      space: u.space,
      amountUsd: '9',
      chain: 'arbitrum',
    });
    if (!b.ok) throw new Error('start failed');
    fake.statuses.set(b.depositAddress, 'FAILED');
    await t.engine.services.funding.poll(t.clock.now);
    expect((await rows(u.userId)).find((x) => x.depositAddress === b.depositAddress)?.state).toBe(
      'failed',
    );
    expect(t.messaging.texts.at(-1)?.text).toContain("didn't arrive. nothing was taken");
  });

  test('an address that times out expires quietly', async () => {
    const r = await t.engine.services.funding.start({
      userId: u.userId,
      space: u.space,
      amountUsd: '6',
      chain: 'base',
    });
    if (!r.ok) throw new Error('start failed');
    const textsBefore = t.messaging.texts.length;
    t.clock.now = new Date(Date.parse(r.expiresAt) + 1_000);
    await t.engine.services.funding.poll(t.clock.now);
    const row = (await rows(u.userId)).find((x) => x.depositAddress === r.depositAddress);
    expect(row?.state).toBe('expired');
    expect(t.messaging.texts.length).toBe(textsBefore); // no nagging about an expired address
    t.clock.now = new Date('2026-11-05T19:00:00Z');
  });

  test('refuses a tiny top-up and a chain it cannot quote', async () => {
    const small = await t.engine.services.funding.start({
      userId: u.userId,
      space: u.space,
      amountUsd: '1',
      chain: 'base',
    });
    expect(small.ok).toBe(false);
    if (!small.ok) expect(small.reasons[0]).toContain('$5.00');

    fake.available = ['base'];
    const noSol = await t.engine.services.funding.start({
      userId: u.userId,
      space: u.space,
      amountUsd: '20',
      chain: 'solana',
    });
    expect(noSol.ok).toBe(false);
    if (!noSol.ok) expect(noSol.reasons[0]).toBe("I can't take money from Solana right now.");
    fake.available = [...fake.available, 'solana'];
  });

  test('with no rail wired, the answer is honest instead of an address', async () => {
    const off = await t.engine.services.funding.start({
      userId: u.userId,
      space: u.space,
      amountUsd: '20',
      chain: 'base',
    });
    expect(off.ok).toBe(true); // this engine has the fake rail

    // A second engine without funding wired.
    const plain = await makeEngine();
    const user = await enrolledUser(plain, '+15550199');
    const r = await plain.engine.services.funding.start({
      userId: user.userId,
      space: user.space,
      amountUsd: '20',
      chain: 'base',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toContain("isn't switched on here yet");
    await plain.db.close();
  });

  test('the model never gets the address back to restate', async () => {
    // A restated address is a way to lose someone's money, so the tool result
    // carries only what was sent, never the address itself.
    const def = createRegistry().get('add_money');
    if (!def) throw new Error('tool missing');
    const out = (await def.execute(
      {
        userId: u.userId,
        space: u.space,
        funding: {
          chains: async () => ['base'],
          start: async () => ({
            ok: true,
            chain: 'base',
            amountUsd: '20',
            depositAddress: 'deposit-base-99',
            expiresAt: new Date().toISOString(),
          }),
        },
      } as never,
      { amountUsd: '20', chain: 'base' },
    )) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.sent).toBe(true);
    expect(JSON.stringify(out)).not.toContain('deposit-base-99');
  });
});
