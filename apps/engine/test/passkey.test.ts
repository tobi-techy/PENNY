import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  approvalSignMessage,
  type MoneyPlan,
  passkeyChallengeFor,
  planApprovalMessage,
  unfreezeMessage,
} from '@penny/shared';
import { sql } from 'drizzle-orm';
import { deviceKeys, idemKey, makeEngine, type TestEngine, tokenFromUrl } from './helpers.ts';
import { assertion, makePasskey, registration, type SoftPasskey } from './webauthn.ts';

/**
 * Part 4: the no-install link card. The WebAuthn assertion is checked on the
 * server, not in the browser. A valid assertion passes; wrong challenge, reused
 * challenge, wrong origin, UV off, bad signature, expired and a changed action
 * each fail.
 */

const ORIGIN = 'https://penny.test';
const RP = 'penny.test';

let t: TestEngine;
let w: Awaited<ReturnType<typeof webUser>>;

/** A user who set up on the web: browser key + passkey, registration checked on the server. */
async function webUser(handle: string) {
  const user = await t.engine.repos.users.findOrCreateByHandle(handle);
  const keys = deviceKeys();
  const pk = makePasskey();
  const { code } = await t.engine.services.enroll.issue(user.id, handle);
  const ch = await t.engine.services.enroll.issuePasskeyChallenge(code);
  if (!ch) throw new Error('no passkey challenge');
  expect(ch.rpId).toBe(RP);
  const r = await t.engine.services.enroll.enroll({
    enrollCode: code,
    publicKeyEd25519: keys.publicKeyB64Url,
    platform: 'web_passkey',
    passkey: registration(pk, { challenge: ch.challenge, origin: ORIGIN, rpId: RP }),
    passkeyChallengeId: ch.challengeId,
  });
  const space = { spaceId: `any;-;${handle}`, userHandle: handle };
  return { userId: user.id, deviceId: r.deviceId, keys, pk, space };
}

beforeAll(async () => {
  t = await makeEngine();
  w = await webUser('+15553000');
  await t.db.db.execute(
    sql`update guard_policies set daily_usd = '100000', max_approvals_per_10_min = 100000 where user_id = ${w.userId}`,
  );
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const send = (amount = '1'): MoneyPlan => ({
  kind: 'send',
  asset: 'USDC',
  amount,
  to: 'ada.penny.near',
});

async function linkCard(plan: MoneyPlan = send()) {
  const before = t.messaging.texts.length;
  const r = await t.engine.services.approvals.createMoneyApproval({
    userId: w.userId,
    bot: null,
    plan,
    space: w.space,
  });
  if (r.decision !== 'allow_with_approval') throw new Error(`expected a card: ${r.reasons}`);
  const sent = t.messaging.texts.slice(before).map((x) => x.text);
  return { ...r, sent };
}

async function approve(
  r: { approvalId: string; cardToken: string },
  opts: Partial<Parameters<typeof assertion>[1]> & { pk?: SoftPasskey } = {},
) {
  const view = await t.engine.services.approvals.getByToken(r.cardToken);
  const a = assertion(opts.pk ?? w.pk, {
    challenge: bound(view.approval),
    origin: ORIGIN,
    rpId: RP,
    ...opts,
  });
  return t.engine.app.request(`/v1/approvals/${r.approvalId}/passkey`, {
    method: 'POST',
    headers: {
      authorization: `Card ${r.cardToken}`,
      'idempotency-key': idemKey(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ assertion: a, signedDelegateAction: 'AAAAAAAA' }),
  });
}

/** What the page asks the passkey to sign: bound to this approval's hash + challenge. */
function bound(a?: { approvalHash: string; challenge?: string }): string {
  return passkeyChallengeFor(approvalSignMessage(a?.approvalHash ?? '', a?.challenge ?? 'none'));
}

const status = async (id: string) => (await t.engine.repos.approvals.get(id))?.status;
/** Why the approval was expired (the audit trail), and that nothing was relayed. */
async function failedWith(id: string, code: string) {
  const events = await t.engine.repos.approvals.events(id);
  expect(events.at(-1)?.reason).toBe(`check failed: ${code}`);
  expect(t.chain.relayCalls).not.toContain(id);
}

describe('web enrollment', () => {
  test('stores the passkey (credential id, COSE key, sign count) and platform web_passkey', async () => {
    const pks = await t.engine.repos.passkeys.activeForUser(w.userId);
    expect(pks).toHaveLength(1);
    expect(pks[0]?.credentialId).toBe(Buffer.from(w.pk.credentialId).toString('base64url'));
    expect(pks[0]?.publicKey.length).toBeGreaterThan(40);
    expect(pks[0]?.signCount).toBe(0);
    const d = await t.engine.repos.users.activeDevice(w.userId);
    expect(d?.platform).toBe('web_passkey');
    expect(d?.hasExtension).toBe(false);
  });

  test('a registration for another origin is refused and the code is not used up', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15553001');
    const { code } = await t.engine.services.enroll.issue(user.id, '+15553001');
    const ch = await t.engine.services.enroll.issuePasskeyChallenge(code);
    if (!ch) throw new Error('no challenge');
    const pk = makePasskey();
    await expect(
      t.engine.services.enroll.enroll({
        enrollCode: code,
        publicKeyEd25519: deviceKeys().publicKeyB64Url,
        platform: 'web_passkey',
        passkey: registration(pk, {
          challenge: ch.challenge,
          origin: 'https://evil.test',
          rpId: RP,
        }),
        passkeyChallengeId: ch.challengeId,
      }),
    ).rejects.toMatchObject({ code: 'passkey_invalid' });
    expect(await t.engine.repos.users.activeDevice(user.id)).toBeNull();
  });
});

describe('link card (no app)', () => {
  test('a no-app user gets a picture link card, never a mini app card', async () => {
    const cards = t.messaging.cards.length;
    const r = await linkCard();
    expect(t.messaging.cards.length).toBe(cards);
    expect(r.sent).toEqual([`https://penny.test/a/${r.cardToken}`]);
    const page = await t.engine.app.request(`/a/${r.cardToken}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(
      `og:image" content="https://penny.test/a/${r.cardToken}/card.png?v=ready"`,
    );
    expect(html).toContain('og:title" content="Send 1 USDC"');
    expect(html).toContain('Approve with Face ID');
    const png = await t.engine.app.request(`/a/${r.cardToken}/card.png`);
    expect(png.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // the page lists this user's passkeys for allowCredentials
    const view = await t.engine.services.approvals.getByToken(r.cardToken);
    expect(view.approval?.passkeys).toEqual([Buffer.from(w.pk.credentialId).toString('base64url')]);
  });

  test('a valid assertion passes, the card goes Sent, and Penny sends a fresh Sent card', async () => {
    const r = await linkCard();
    const before = t.messaging.texts.length;
    const res = await approve(r);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'settled' });
    const fresh = t.messaging.texts.slice(before).map((x) => x.text);
    expect(fresh.some((u) => u.startsWith(`https://penny.test/a/${r.cardToken}?v=sent`))).toBe(
      true,
    );
    const view = await t.engine.services.approvals.getByToken(r.cardToken);
    expect(view.card.state).toBe('sent');
    expect(view.approval?.challenge).toBeUndefined();
  });

  test('wrong challenge fails, the approval expires and a new card is sent', async () => {
    const r = await linkCard();
    const res = await approve(r, { challenge: Buffer.alloc(32, 7).toString('base64url') });
    expect(res.status).toBe(422);
    expect(await status(r.approvalId)).toBe('expired');
    await failedWith(r.approvalId, 'bad_passkey');
    const next = await t.engine.repos.approvals.byReissuedFrom(r.approvalId);
    expect(next?.status).toBe('pending');
    expect(tokenFromUrl(t.messaging.texts.at(-2)?.text)).not.toBe(r.cardToken);
  });

  test('a reused challenge fails (no second relay)', async () => {
    const r = await linkCard();
    const view = await t.engine.services.approvals.getByToken(r.cardToken);
    const challenge = bound(view.approval);
    expect((await approve(r, { challenge })).status).toBe(200);
    const relays = t.chain.relayCalls.length;
    const again = await approve(r, { challenge, signCount: 9 });
    expect(again.status).toBe(409);
    expect(t.chain.relayCalls.length).toBe(relays);
  });

  test('the raw challenge (not bound to the approval) fails', async () => {
    const r = await linkCard();
    const view = await t.engine.services.approvals.getByToken(r.cardToken);
    expect((await approve(r, { challenge: view.approval?.challenge as string })).status).toBe(422);
    await failedWith(r.approvalId, 'bad_passkey');
  });

  test('a passkey answer for one approval does not approve another', async () => {
    const a = await linkCard();
    const b = await linkCard();
    const va = await t.engine.services.approvals.getByToken(a.cardToken);
    // the assertion is over approval A's bound challenge, sent to approval B
    expect((await approve(b, { challenge: bound(va.approval) })).status).toBe(422);
    await failedWith(b.approvalId, 'bad_passkey');
  });

  test('wrong origin fails', async () => {
    const r = await linkCard();
    expect((await approve(r, { origin: 'https://evil.test' })).status).toBe(422);
    expect(await status(r.approvalId)).toBe('expired');
    await failedWith(r.approvalId, 'bad_passkey');
  });

  test('wrong rpId fails', async () => {
    const r = await linkCard();
    expect((await approve(r, { rpId: 'evil.test' })).status).toBe(422);
    await failedWith(r.approvalId, 'bad_passkey');
  });

  test('UV off fails', async () => {
    const r = await linkCard();
    expect((await approve(r, { uv: false })).status).toBe(422);
    expect(await status(r.approvalId)).toBe('expired');
    await failedWith(r.approvalId, 'bad_passkey');
  });

  test('a bad signature fails', async () => {
    const r = await linkCard();
    expect((await approve(r, { breakSignature: true })).status).toBe(422);
    await failedWith(r.approvalId, 'bad_passkey');
  });

  test('a passkey that is not this user’s fails', async () => {
    const r = await linkCard();
    expect((await approve(r, { pk: makePasskey() })).status).toBe(403);
    await failedWith(r.approvalId, 'unknown_passkey');
  });

  test('the sign count must not go backwards', async () => {
    const pk = (await t.engine.repos.passkeys.activeForUser(w.userId))[0];
    if (!pk) throw new Error('no passkey');
    await t.db.db.execute(sql`update passkeys set sign_count = 10 where id = ${pk.id}`);
    const r = await linkCard();
    expect((await approve(r, { signCount: 5 })).status).toBe(422);
    await failedWith(r.approvalId, 'bad_passkey');
    const ok = await linkCard();
    expect((await approve(ok, { signCount: 11 })).status).toBe(200);
    expect((await t.engine.repos.passkeys.byCredentialId(pk.credentialId))?.signCount).toBe(11);
    await t.db.db.execute(sql`update passkeys set sign_count = 0 where id = ${pk.id}`);
  });

  test('expired fails', async () => {
    const r = await linkCard();
    const view = await t.engine.services.approvals.getByToken(r.cardToken);
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 601_000);
    try {
      const a = assertion(w.pk, {
        challenge: bound(view.approval),
        origin: ORIGIN,
        rpId: RP,
      });
      const res = await t.engine.app.request(`/v1/approvals/${r.approvalId}/passkey`, {
        method: 'POST',
        headers: {
          authorization: `Card ${r.cardToken}`,
          'idempotency-key': idemKey(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ assertion: a, signedDelegateAction: 'AAAAAAAA' }),
      });
      expect(res.status).toBe(410);
      expect(await status(r.approvalId)).toBe('expired');
      expect(t.chain.relayCalls).not.toContain(r.approvalId);
    } finally {
      t.clock.now = saved;
    }
  });

  test('a changed action fails (the hash no longer matches)', async () => {
    const r = await linkCard(send('2'));
    await t.db.db.execute(
      sql`update approvals set plan = jsonb_set(plan, '{amount}', '"20"') where id = ${r.approvalId}`,
    );
    const res = await approve(r);
    expect(res.status).toBe(422);
    expect(await status(r.approvalId)).toBe('expired');
    await failedWith(r.approvalId, 'changed');
  });

  test('unfreeze from the web: the passkey of the frozen browser answers the Unfreeze card', async () => {
    const f = await webUser('+15553010');
    await t.engine.services.approvals.freeze(f.userId);
    const before = t.messaging.texts.length;
    expect(await t.engine.services.approvals.startUnfreeze(f.userId, f.space)).toBe('card_sent');
    // a no-app user gets the Unfreeze card as a link card
    const token = tokenFromUrl(t.messaging.texts.slice(before).at(-1)?.text);
    const view = await t.engine.services.approvals.getByToken(token);
    expect(view.unfreeze?.passkeys).toEqual([Buffer.from(f.pk.credentialId).toString('base64url')]);
    const challenge = passkeyChallengeFor(
      unfreezeMessage(view.card.id, view.unfreeze?.challenge as string),
    );
    const res = await t.engine.app.request(`/v1/cards/by-token/${token}/unfreeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
      body: JSON.stringify({ assertion: assertion(f.pk, { challenge, origin: ORIGIN, rpId: RP }) }),
    });
    expect(res.status).toBe(200);
    expect((await t.engine.repos.users.activeDevice(f.userId))?.id).toBe(f.deviceId);
  });

  test('an over-limit send on the link path: Blocked card, no approval card', async () => {
    await t.db.db.execute(
      sql`update guard_policies set per_tx_usd = '50' where user_id = ${w.userId}`,
    );
    const before = t.messaging.texts.length;
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: w.userId,
      bot: null,
      plan: send('500'),
      space: w.space,
    });
    expect(r.decision).toBe('block');
    const sent = t.messaging.texts.slice(before).map((x) => x.text);
    expect(sent).toHaveLength(1);
    const view = await t.engine.services.approvals.getByToken(tokenFromUrl(sent[0]));
    expect(view.card.type).toBe('guard_block');
    expect(view.card.kind).toBe('info');
    expect(view.approval).toBeUndefined();
  });

  test('a write approval on the link path signs the plan with the browser key', async () => {
    const plan = {
      kind: 'write' as const,
      toolkit: 'gmail',
      toolSlug: 'GMAIL_SEND_EMAIL',
      title: 'Email to Amara',
      summary: 'Invoice',
      arguments: { recipient_email: 'amara@example.com', subject: 'Invoice', body: 'Hi' },
    };
    const fake = (await import('../src/connectors/composio.ts')).FakeConnector;
    const t2 = await makeEngine({ connectors: new fake() });
    try {
      // same browser key + passkey shape, on a fresh engine
      const saved = t;
      t = t2;
      const u2 = await webUser('+15553002');
      t = saved;
      const r = await t2.engine.services.approvals.createWriteApproval({
        userId: u2.userId,
        bot: null,
        plan,
        space: u2.space,
      });
      if (r.decision !== 'allow_with_approval') throw new Error('expected card');
      const view = await t2.engine.services.approvals.getByToken(r.cardToken);
      const a = assertion(u2.pk, {
        challenge: bound(view.approval),
        origin: ORIGIN,
        rpId: RP,
      });
      const planSignature = u2.keys.sign(
        planApprovalMessage(
          r.approvalId,
          (await t2.engine.repos.approvals.get(r.approvalId))?.planHash as string,
        ),
      );
      const res = await t2.engine.app.request(`/v1/approvals/${r.approvalId}/passkey`, {
        method: 'POST',
        headers: {
          authorization: `Card ${r.cardToken}`,
          'idempotency-key': idemKey(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ assertion: a, planSignature }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'settled' });
    } finally {
      await t2.db.close();
    }
  });
});
