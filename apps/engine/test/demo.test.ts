import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { Approval } from '@penny/shared';
import { createPgliteDb, type DbHandle } from '../src/db/client.ts';
import { sha256Hex } from '../src/lib/crypto.ts';
import { FakeChain } from '../src/ports/chain.ts';
import { DemoChain } from '../src/ports/demo-chain.ts';
import {
  cardTokenOf,
  DemoAwareMessaging,
  DemoMessaging,
  demoSessionOf,
  demoSpaceId,
} from '../src/ports/demo-messaging.ts';
import type { ApprovalCard, CardHandle, MessagingPort, SpaceRef } from '../src/ports/messaging.ts';
import { DemoRepo } from '../src/repo/demo.ts';
import { UsersRepo } from '../src/repo/users.ts';
import { makeEngine, type TestEngine, tokenFromUrl } from './helpers.ts';

/**
 * The public demo. What has to hold:
 *  - a demo space writes to the browser thread, a real space is untouched
 *  - the demo answers "is this key on chain" from enrollment, and still runs every
 *    byte-for-byte and signature check on a real browser-signed delegate action
 *    (that half lives in apps/web/test/demo-chain.test.ts, next to the encoder)
 *  - a demo approval is never broadcast
 *  - a real account is never routed through any of it
 */
const ACCOUNT = 'demo-abcdefghijklmnopqrst.testnet';
const T0 = new Date('2026-11-11T16:00:00Z');

describe('demo transport', () => {
  let db: DbHandle;
  let demo: DemoRepo;
  let port: DemoMessaging;
  let inner: RecordingPort;
  let routed: DemoAwareMessaging;

  class RecordingPort implements MessagingPort {
    texts: { spaceId: string; text: string }[] = [];
    async sendText(s: SpaceRef, text: string) {
      this.texts.push({ spaceId: s.spaceId, text });
    }
    async sendLink(s: SpaceRef, url: string) {
      this.texts.push({ spaceId: s.spaceId, text: url });
    }
    async startTyping(_s: SpaceRef) {}
    async stopTyping(_s: SpaceRef) {}
    async sendCard(_s: SpaceRef, _c: ApprovalCard): Promise<CardHandle> {
      return { cardId: 'c', ref: 'r' };
    }
    async editCard(_h: CardHandle, _c: ApprovalCard) {}
  }

  beforeAll(async () => {
    db = await createPgliteDb();
    demo = new DemoRepo(db.db);
    port = new DemoMessaging(demo);
    inner = new RecordingPort();
    routed = new DemoAwareMessaging(inner, port);
    const user = await new UsersRepo(db.db).findOrCreateByHandle('demo:seed');
    await demo.create('s'.repeat(43), user.id, null, T0);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  test('a demo space is a demo space', () => {
    expect(demoSpaceId('abc')).toBe('demo;abc');
    expect(demoSessionOf('demo;abc')).toBe('abc');
    expect(demoSessionOf('any;-;+15550100')).toBeNull();
  });

  test('the card URL is recognised, with or without the cache-busting version', () => {
    const url = `https://penny.test/a/${'t'.repeat(43)}`;
    expect(cardTokenOf(url)?.url).toBe(url);
    expect(cardTokenOf(`${url}?v=sent-2`)?.url).toBe(url);
    expect(cardTokenOf('just words')).toBeNull();
  });

  test('Penny text lands in the thread; a card arrives as a card, not a URL', async () => {
    const space = { spaceId: demoSpaceId('s'.repeat(43)), userHandle: 'demo:x' };
    await port.sendText(space, 'i found your bill.');
    await port.sendText(space, `https://penny.test/a/${'t'.repeat(43)}?v=ready-1`);
    await port.startTyping(space);
    const thread = await demo.thread('s'.repeat(43));
    expect(thread).toHaveLength(2);
    expect(thread[0]).toMatchObject({ kind: 'text', direction: 'outbound' });
    expect(thread[1]).toMatchObject({ kind: 'card', direction: 'outbound' });
    // the version suffix is iMessage's cache buster, not part of the card
    expect(thread[1]?.url).toBe(`https://penny.test/a/${'t'.repeat(43)}`);
  });

  test('a real iMessage space never reaches the demo thread', async () => {
    const before = (await demo.thread('s'.repeat(43))).length;
    await routed.sendText({ spaceId: 'any;-;+15550100', userHandle: '+15550100' }, 'hello');
    expect(inner.texts).toEqual([{ spaceId: 'any;-;+15550100', text: 'hello' }]);
    expect(await demo.thread('s'.repeat(43))).toHaveLength(before);
  });

  test('a session expires; turns are capped; the sweeper clears the thread', async () => {
    expect(await demo.get('s'.repeat(43), T0)).not.toBeNull();
    expect(await demo.get('s'.repeat(43), new Date(T0.getTime() + 25 * 60 * 60_000))).toBeNull();
    expect(await demo.spendTurn('s'.repeat(43), 2)).toBe(1);
    expect(await demo.spendTurn('s'.repeat(43), 2)).toBe(2);
    expect(await demo.spendTurn('s'.repeat(43), 2)).toBeNull();
    const pruned = await demo.prune(new Date(T0.getTime() + 25 * 60 * 60_000));
    expect(pruned).toBe(1);
    expect(await demo.thread('s'.repeat(43))).toHaveLength(0);
  });
});

describe('demo chain: never a broadcast, never a real account', () => {
  const seed = new Uint8Array(32).fill(7);
  const publicKey = ed25519.getPublicKey(seed);
  const publicKeyB64Url = Buffer.from(publicKey).toString('base64url');

  const approval = (over: Partial<Approval> = {}): Approval =>
    ({
      id: 'apr_demo1',
      userId: 'usr_demo',
      kind: 'send',
      plan: { kind: 'send', asset: 'NEAR', amount: '5', to: 'amara.testnet' },
      title: 'Send 5 NEAR',
      amountDisplay: '5 NEAR',
      facts: [],
      signerId: ACCOUNT,
      receiverId: 'amara.testnet',
      actions: [{ type: 'Transfer', deposit: '5000000000000000000000000' }],
      nonce: '1',
      maxBlockHeight: '1001',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      status: 'pending',
      planHash: 'p'.repeat(43),
      ...over,
    }) as Approval;

  const chain = (account = ACCOUNT) =>
    new DemoChain({
      inner: new FakeChain(),
      isDemoAccount: async (id) => id === account,
      resolveDeviceKey: async (id) => (id === account ? publicKeyB64Url : null),
    });

  test('signing material is synthesised only for a demo account', async () => {
    const s = await chain().prepareSigning(ACCOUNT, publicKeyB64Url, 600);
    expect(s.nonce).toBe('1');
    expect(BigInt(s.maxBlockHeight)).toBeGreaterThan(1n);
    // a real account still goes to the adapter, which the fake answers itself
    expect(await chain().prepareSigning('real.penny.near', publicKeyB64Url, 600)).toEqual({
      nonce: '1001',
      maxBlockHeight: '200000000',
    });
  });

  test('a demo approval relays as a dry run and reports no transaction', async () => {
    const r = await chain().relay(approval(), 'AAAA');
    expect(r).toEqual({ ok: true, txHash: 'demo-apr_demo1', dryRun: true });
    expect(await chain().txStatus('demo-apr_demo1')).toBe('pending');
  });

  test('a real account is passed straight through to the adapter', async () => {
    const real = new FakeChain();
    const demo = new DemoChain({
      inner: real,
      isDemoAccount: async () => false,
      resolveDeviceKey: async () => publicKeyB64Url,
    });
    const a = approval({ signerId: 'real.penny.near' });
    const r = await demo.verifyDelegateAction(a, 'AAAAAAAA');
    expect(r).toEqual({ ok: true });
    expect(real.verifyCalls).toEqual(['apr_demo1']);
  });

  test('an expired demo approval is refused before anything else', async () => {
    const expired = approval({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const r = await chain().verifyDelegateAction(expired, 'AAAAAAAA');
    expect(r).toEqual({ ok: false, reason: 'EXPIRED: approval expired' });
  });
});

describe('/demo routes', () => {
  let t: TestEngine;

  beforeAll(async () => {
    t = await makeEngine({
      // the same composition main.ts uses: demo spaces go to the browser thread
      messagingWrap: (inner, dbh) =>
        new DemoAwareMessaging(inner, new DemoMessaging(new DemoRepo(dbh.db))),
      extra: { demo: { maxTurns: 2, sessionsPerHour: 500 } },
    });
  }, 120_000);
  afterAll(async () => {
    await t?.db.close();
  });

  const start = () =>
    t.engine.app.request('/v1/demo/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

  test('opening a session names what is live and what is simulated', async () => {
    const res = await start();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      enrollCode: string;
      accountId: string;
      prompts: { text: string }[];
      live: string[];
      simulated: string[];
    };
    expect(body.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.accountId).toBe(`demo-${body.sessionId.slice(0, 20).toLowerCase()}.testnet`);
    expect(body.prompts.length).toBeGreaterThanOrEqual(4);
    expect(body.live).toContain('the signature check');
    expect(body.simulated).toContain('the broadcast');
    const user = await t.engine.repos.users.byAccountId(body.accountId);
    expect(user?.isDemo).toBe(true);
  });

  test('the browser enrolls a key and the thread runs the real pipeline', async () => {
    const s = (await (await start()).json()) as { sessionId: string; enrollCode: string };
    const key = Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(3))).toString('base64url');
    const enrolled = await t.engine.app.request('/v1/demo/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: s.sessionId,
        enrollCode: s.enrollCode,
        publicKeyEd25519: key,
      }),
    });
    expect(enrolled.status).toBe(200);

    const said = await t.engine.app.request('/v1/demo/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: s.sessionId, text: 'hi' }),
    });
    expect(said.status).toBe(200);
    const { messages } = (await said.json()) as {
      messages: { direction: string; kind: string; text: string | null }[];
    };
    expect(messages.some((m) => m.direction === 'inbound' && m.text === 'hi')).toBe(true);
    expect(messages.some((m) => m.direction === 'outbound')).toBe(true);
  }, 60_000);

  test('turns are capped and the session can be read back by its own token', async () => {
    const s = (await (await start()).json()) as { sessionId: string };
    for (let i = 0; i < 2; i += 1) {
      const r = await t.engine.app.request('/v1/demo/say', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: s.sessionId, text: 'hi' }),
      });
      expect(r.status).toBe(200);
    }
    const blocked = await t.engine.app.request('/v1/demo/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: s.sessionId, text: 'again' }),
    });
    expect(blocked.status).toBe(429);
    const thread = await t.engine.app.request(`/v1/demo/thread?session=${s.sessionId}`);
    expect(thread.status).toBe(200);
    const other = await t.engine.app.request(`/v1/demo/thread?session=${'z'.repeat(43)}`);
    expect(other.status).toBe(410);
  }, 60_000);

  test('a blocked send lands in the thread as a card the page can render', async () => {
    const s = (await (await start()).json()) as { sessionId: string; enrollCode: string };
    const key = Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(4))).toString('base64url');
    await t.engine.app.request('/v1/demo/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: s.sessionId,
        enrollCode: s.enrollCode,
        publicKeyEd25519: key,
      }),
    });
    const user = await t.engine.repos.users.byAccountId(
      `demo-${s.sessionId.slice(0, 20).toLowerCase()}.testnet`,
    );
    if (!user) throw new Error('demo user missing');

    // $400 is over the $50 per-transaction and $100 daily policy, so the Guard
    // refuses before any card is signed: the same path the phone takes.
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: user.id,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '400', to: 'new-wallet.testnet' },
      space: { spaceId: demoSpaceId(s.sessionId), userHandle: `demo:${s.sessionId}` },
    });
    expect(r.decision).toBe('block');

    const { messages } = (await (
      await t.engine.app.request(`/v1/demo/thread?session=${s.sessionId}`)
    ).json()) as { messages: { kind: string; url: string | null }[] };
    const card = messages.find((m) => m.kind === 'card');
    expect(card?.url).toMatch(/\/a\/[A-Za-z0-9_-]{43}$/);

    // the page shows exactly this picture: the engine's own card render
    const png = await t.engine.app.request(`/a/${tokenFromUrl(card?.url ?? undefined)}/card.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
  }, 60_000);

  test('reading the thread closes a card approved in the sheet', async () => {
    const s = (await (await start()).json()) as { sessionId: string; enrollCode: string };
    const key = Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(5))).toString('base64url');
    await t.engine.app.request('/v1/demo/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: s.sessionId,
        enrollCode: s.enrollCode,
        publicKeyEd25519: key,
      }),
    });
    const user = await t.engine.repos.users.byAccountId(
      `demo-${s.sessionId.slice(0, 20).toLowerCase()}.testnet`,
    );
    if (!user) throw new Error('demo user missing');
    await t.engine.services.approvals.createMoneyApproval({
      userId: user.id,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '400', to: 'new-wallet.testnet' },
      space: { spaceId: demoSpaceId(s.sessionId), userHandle: `demo:${s.sessionId}` },
    });

    // Approving a card never comes back through /say: move a card to the state the
    // real sign path leaves it in, then read the thread the way the page polls it.
    const thread = (await (
      await t.engine.app.request(`/v1/demo/thread?session=${s.sessionId}`)
    ).json()) as { messages: { kind: string; url: string | null }[] };
    const token = tokenFromUrl(thread.messages.find((m) => m.kind === 'card')?.url ?? undefined);
    const row = await t.engine.repos.cards.byTokenHash(sha256Hex(token));
    if (!row) throw new Error('card missing');
    await t.engine.repos.cards.update(row.id, { state: 'approving' });

    const after = (await (
      await t.engine.app.request(`/v1/demo/thread?session=${s.sessionId}`)
    ).json()) as { messages: { kind: string; url: string | null }[] };
    const settled = await t.engine.repos.cards.get(row.id);
    expect(settled?.state).toBe('sent');
    expect(settled?.statusLine).toContain('nothing was sent in this demo');
    // the closed card is re-sent so the page paints the new state on the same token
    expect(
      after.messages.filter((m) => m.kind === 'card' && tokenFromUrl(m.url ?? undefined) === token)
        .length,
    ).toBe(2);
  }, 60_000);

  test('the demo is off unless the engine was started with it', async () => {
    const plain = await makeEngine();
    try {
      const res = await plain.engine.app.request('/v1/demo/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(404);
    } finally {
      await plain.db.close();
    }
  }, 120_000);
});
