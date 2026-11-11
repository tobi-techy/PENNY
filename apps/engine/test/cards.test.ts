import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Card, planApprovalMessage, unfreezeMessage } from '@penny/shared';
import { sql } from 'drizzle-orm';
import { FROZEN_TEXT } from '../src/approvals/service.ts';
import { BUILT_IN_BOTS } from '../src/brain/bots.ts';
import { createRegistry } from '../src/brain/tools.ts';
import { APPROVAL_POLICY, needsApproval } from '../src/cards/policy.ts';
import { renderCardPng } from '../src/cards/render.ts';
import { linkSubcaptionStates, pickChannel } from '../src/cards/sender.ts';
import { FakeConnector } from '../src/connectors/composio.ts';
import { FREEZE_REPLY, freezeCommand, UNFREEZE_REPLY, WELCOME_TEXT } from '../src/inbound.ts';
import { createLogger } from '../src/lib/logger.ts';
import type { DeviceRow } from '../src/repo/users.ts';
import {
  enrolledUser,
  idemKey,
  makeEngine,
  scriptedModel,
  signBody,
  type TestEngine,
  tokenFromUrl,
} from './helpers.ts';

let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;
const fake = new FakeConnector();

beforeAll(async () => {
  t = await makeEngine({ connectors: fake, extra: { sleep: async () => {} } });
  u = await enrolledUser(t);
  await t.db.db.execute(
    sql`update guard_policies set daily_usd = '100000', max_approvals_per_10_min = 100000 where user_id = ${u.userId}`,
  );
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const press = (token: string, buttonId: string, confirm?: boolean) =>
  t.engine.app.request(`/v1/cards/by-token/${token}/press`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
    body: JSON.stringify({ buttonId, ...(confirm !== undefined ? { confirm } : {}) }),
  });

describe('needsApproval: one policy table, never the model', () => {
  const registry = createRegistry();

  test('covers every tool in the registry, explicitly', () => {
    for (const tool of registry.list()) {
      expect(APPROVAL_POLICY[tool.id]).toBeDefined();
      // read-only tools never need Face ID; write and money tools always do
      expect(needsApproval({ tool: tool.id, risk: tool.risk })).toBe(tool.risk !== 'read');
    }
  });
  test('every tool a built-in bot uses is in the table', () => {
    for (const b of BUILT_IN_BOTS)
      for (const id of b.toolIds) expect(APPROVAL_POLICY[id]).toBeDefined();
  });
  test('sending email and posting need approval; a reminder does not', () => {
    expect(needsApproval({ tool: 'send_email' })).toBe(true);
    expect(needsApproval({ tool: 'post_x' })).toBe(true);
    expect(needsApproval({ tool: 'propose_write' })).toBe(true);
    expect(needsApproval({ tool: 'accept_invite' })).toBe(true);
    expect(needsApproval({ tool: 'grant_bot_write' })).toBe(true);
    expect(needsApproval({ tool: 'set_reminder' })).toBe(false);
    expect(needsApproval({ tool: 'draft_email' })).toBe(false);
  });
  test('anything new that writes defaults to approval; new read tools do not', () => {
    expect(needsApproval({ tool: 'book_table' })).toBe(true);
    expect(needsApproval({ tool: 'book_table', risk: 'write' })).toBe(true);
    expect(needsApproval({ tool: 'weather_lookup', risk: 'read' })).toBe(false);
  });
  test('a known tool can never be downgraded below its declared risk', () => {
    expect(needsApproval({ tool: 'set_reminder', risk: 'money' })).toBe(true);
  });
  test('buttons: undo/edit/pick/open never need Face ID; send and approve do', () => {
    for (const b of ['undo', 'edit', 'pick', 'open', 'decline', 'renew', 'freeze'])
      expect(needsApproval({ button: b })).toBe(false);
    expect(needsApproval({ button: 'send' })).toBe(true);
    expect(needsApproval({ button: 'approve' })).toBe(true);
    expect(needsApproval({ button: 'something_new' })).toBe(true);
  });
});

describe('card picker', () => {
  const dev = (over: Partial<DeviceRow>): DeviceRow =>
    ({ platform: 'ios_app', hasExtension: true, revokedAt: null, ...over }) as DeviceRow;
  test('live card only for an active iOS app device with the extension', () => {
    expect(pickChannel(dev({}))).toBe('live');
    expect(pickChannel(dev({ hasExtension: false }))).toBe('link');
    expect(pickChannel(dev({ platform: 'web_passkey', hasExtension: false }))).toBe('link');
    expect(pickChannel(dev({ revokedAt: new Date() }))).toBe('link');
    expect(pickChannel(null)).toBe('link');
  });
});

describe('live card (Photon customizedMiniApp)', () => {
  test('layout: caption, subcaption, trailing countdown; same URL as the link page', async () => {
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'NEAR', amount: '0.1', to: 'amara.testnet' },
      space: u.space,
      nearUsdPriceMicros: 4_000_000n,
    });
    if (r.decision !== 'allow_with_approval') throw new Error(r.reasons.join());
    const card = t.messaging.cards.at(-1)?.card;
    expect(card).toMatchObject({
      caption: 'Send 0.1 NEAR',
      subcaption: 'to amara.testnet',
      trailingCaption: '10:00 left',
      live: true,
      url: `https://penny.test/a/${r.cardToken}`,
    });
    const view = await t.engine.services.approvals.getByToken(r.cardToken);
    expect(view.card.amount).toBe('0.1 NEAR');
    expect(view.approval?.action).toEqual({
      type: 'send',
      to: 'amara.testnet',
      amount: '0.1',
      asset: 'NEAR',
    });
  });

  test('the live card input passes the Photon SDK (cloud @spectrum-ts/imessage) validation', async () => {
    const { SpectrumMessaging } = await import('../src/ports/spectrum.ts');
    const { customizedMiniApp } = await import('@spectrum-ts/imessage');
    const input = SpectrumMessaging.input(
      {
        projectId: 'p',
        projectSecret: 's',
        appName: 'Penny',
        extensionBundleId: 'app.penny.host.messages',
        teamId: 'TEAM123456',
      },
      {
        cardId: 'crd_01JC0000000000000000000000',
        url: 'https://penny.test/a/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE',
        caption: 'Send 0.1 NEAR',
        subcaption: 'to amara.testnet',
        trailingCaption: '1:30 left',
        image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        imageTitle: 'Send 0.1 NEAR',
        live: true,
      },
    );
    const built = (await customizedMiniApp(input as never).build()) as unknown as Record<
      string,
      unknown
    >;
    expect(built).toMatchObject({
      type: 'customized-mini-app',
      appName: 'Penny',
      extensionBundleId: 'app.penny.host.messages',
      teamId: 'TEAM123456',
      live: true,
      layout: {
        caption: 'Send 0.1 NEAR',
        subcaption: 'to amara.testnet',
        trailingCaption: '1:30 left',
      },
    });
  });

  test('a failed edit is retried 3 times, then a fresh card is sent', async () => {
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    // two failures, then the third try works: still one card
    t.messaging.failEdits = 2;
    let attempts = t.messaging.editAttempts;
    let cards = t.messaging.cards.length;
    await t.engine.services.approvals.decline(r.approvalId, r.cardToken);
    expect(t.messaging.editAttempts - attempts).toBe(3);
    expect(t.messaging.cards.length).toBe(cards);
    // three failures: a fresh card with the same URL
    const r2 = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r2.decision !== 'allow_with_approval') throw new Error('expected card');
    // a state the user is waiting on (sent): three failures, then a fresh card, same URL
    t.messaging.failEdits = 3;
    attempts = t.messaging.editAttempts;
    cards = t.messaging.cards.length;
    const cardId = (await t.engine.repos.approvals.get(r2.approvalId))?.cardId as string;
    await t.engine.services.cards.update(cardId, { state: 'sent' }, { subcaption: 'sent' });
    expect(t.messaging.editAttempts - attempts).toBe(3);
    expect(t.messaging.cards.length).toBe(cards + 1);
    expect(t.messaging.cards.at(-1)?.card.url).toBe(`https://penny.test/a/${r2.cardToken}`);
    expect(t.messaging.cards.at(-1)?.card.subcaption).toBe('sent');
    // an unanswered card expiring is not worth a new message, even when the edit fails
    const r3 = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r3.decision !== 'allow_with_approval') throw new Error('expected card');
    t.messaging.failEdits = 3;
    cards = t.messaging.cards.length;
    const texts = t.messaging.texts.length;
    const id3 = (await t.engine.repos.approvals.get(r3.approvalId))?.cardId as string;
    await t.engine.services.cards.update(id3, { state: 'expired' });
    expect(t.messaging.cards.length).toBe(cards);
    expect(t.messaging.texts.length).toBe(texts);
    t.messaging.failEdits = 0;
  });
});

describe('every agent ends in a valid card', () => {
  test('approval, blocked, reminder and draft cards all parse as Card', async () => {
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '2', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    const rows = (await t.db.db.execute(
      sql`select id from cards where user_id = ${u.userId}`,
    )) as unknown as {
      rows: { id: string }[];
    };
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const { id } of rows.rows) {
      const c = await t.engine.repos.cards.get(id);
      const { toCardDto } = await import('../src/cards/sender.ts');
      if (!c) throw new Error('missing');
      expect(Card.safeParse(toCardDto(c)).success).toBe(true);
    }
  });

  test('an unknown card type renders (plain card), never a crash', async () => {
    const png = await renderCardPng(
      {
        id: 'crd_01JC0000000000000000000000',
        userId: 'usr_x',
        agent: 'x-manager',
        kind: 'info',
        type: 'weather_report',
        title: 'Rain at 4pm',
        lines: [{ value: 'Take a coat.' }],
        buttons: [{ id: 'open', label: 'Open', action: 'open' }],
        state: 'done',
        createdAt: new Date().toISOString(),
      },
      new Date(),
    );
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(5_000);
  });

  test('live bubble copy for every state is plain words', () => {
    for (const line of linkSubcaptionStates()) expect(line.length).toBeGreaterThan(0);
  });
});

describe('DONE: "remind me to call mum at 7"', () => {
  test('an info card with Undo, no Face ID, and Undo works', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'reminder' } }]),
      scriptedModel([
        { tool: 'set_reminder', input: { text: 'call mum', dueAt: '2026-11-06T07:00:00+01:00' } },
        { text: "done. i'll remind you at 7." },
      ]),
    );
    const approvalsBefore = (await t.engine.repos.approvals.listForUser(u.userId, 50)).length;
    const cardsBefore = t.messaging.cards.length;
    const conv = await t.engine.repos.users.conversationFor(u.userId, u.space.spaceId, 'imessage');
    await t.engine.services.crew.handle(u.userId, u.space, 'remind me to call mum at 7', {
      conversationId: conv,
      enrolled: true,
    });
    expect(t.messaging.cards.length).toBe(cardsBefore + 1);
    const live = t.messaging.cards.at(-1)?.card;
    expect(live?.caption).toBe('Reminder set for 7am');
    expect(live?.subcaption).toBe('what call mum');
    // no approval record, no Face ID
    expect((await t.engine.repos.approvals.listForUser(u.userId, 50)).length).toBe(approvalsBefore);
    const token = tokenFromUrl(live?.url);
    const view = await t.engine.services.approvals.getByToken(token);
    expect(view.card).toMatchObject({ kind: 'info', type: 'reminder', state: 'done' });
    expect(view.card.buttons).toEqual([{ id: 'undo', label: 'Undo', action: 'undo' }]);
    expect(view.approval).toBeUndefined();
    // Undo: no Face ID, the card edits in place
    const res = await press(token, 'undo');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { card: { state: string; title: string } };
    expect(body.card.state).toBe('undone');
    expect(t.messaging.edits.at(-1)?.card.subcaption).toBe('undone');
    // the reminder never fires
    const textsBefore = t.messaging.texts.length;
    t.clock.now = new Date('2026-11-06T07:00:01+01:00');
    await t.engine.services.scheduler.tick();
    t.clock.now = new Date('2026-11-05T19:00:00Z');
    expect(t.messaging.texts.slice(textsBefore).some((x) => x.text.includes('call mum'))).toBe(
      false,
    );
  });

  test('a reminder that is not undone fires once', async () => {
    const { setReminder } = await import('../src/cards/everyday.ts');
    const r = await setReminder(
      { reminders: t.engine.repos.reminders, cards: cardSender(), now: () => t.clock.now },
      {
        userId: u.userId,
        space: u.space,
        agent: 'penny',
        text: 'water the plants',
        dueAt: '2026-11-05T19:30:00Z',
      },
    );
    expect(r.ok).toBe(true);
    const before = t.messaging.texts.length;
    // later than any earlier tick, so the job is due
    t.clock.now = new Date('2026-11-07T09:00:00Z');
    await t.engine.services.scheduler.tick();
    await t.engine.services.scheduler.tick();
    t.clock.now = new Date('2026-11-05T19:00:00Z');
    const fired = t.messaging.texts
      .slice(before)
      .filter((x) => x.text === 'reminder: water the plants');
    expect(fired).toHaveLength(1);
  });
});

/** The engine's CardSender (the one every agent uses). */
function cardSender() {
  return t.engine.services.cards;
}

describe('DONE: "email Amara the invoice"', () => {
  test('a draft card; Send turns it into an approval card that needs Face ID', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'email' } }]),
      scriptedModel([
        {
          tool: 'draft_email',
          input: {
            toName: 'Amara',
            toEmail: 'amara@example.com',
            subject: 'Invoice',
            body: 'Hi Amara, the invoice is attached.',
          },
        },
        { text: 'drafted. tap send when it looks right.' },
      ]),
    );
    await t.engine.services.crew.handle(u.userId, u.space, 'email Amara the invoice', {
      enrolled: true,
    });
    const live = t.messaging.cards.at(-1)?.card;
    expect(live?.caption).toBe('Email to Amara ready');
    const token = tokenFromUrl(live?.url);
    let view = await t.engine.services.approvals.getByToken(token);
    expect(view.card).toMatchObject({ kind: 'info', type: 'email_draft' });
    expect(view.card.buttons.map((b) => b.label)).toEqual(['Send', 'Edit']);
    expect(view.approval).toBeUndefined();

    // Edit: no Face ID
    const edit = await t.engine.app.request(`/v1/cards/by-token/${token}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
      body: JSON.stringify({ text: 'Hi Amara, invoice attached. Thanks!' }),
    });
    expect(edit.status).toBe(200);
    // a long edit is kept for sending but the card only shows the first 120 chars
    const tooLong = await t.engine.app.request(`/v1/cards/by-token/${token}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
      body: JSON.stringify({ text: 'x'.repeat(721) }),
    });
    expect(tooLong.status).toBe(200);
    expect((await t.engine.services.approvals.getByToken(token)).card.lines.at(-1)?.value).toBe(
      'x'.repeat(120),
    );
    // put the short text back
    const short = await t.engine.app.request(`/v1/cards/by-token/${token}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
      body: JSON.stringify({ text: 'Hi Amara, invoice attached. Thanks!' }),
    });
    expect(short.status).toBe(200);
    expect((await t.engine.services.approvals.getByToken(token)).card.lines.at(-1)?.value).toBe(
      'Hi Amara, invoice attached. Thanks!',
    );

    // Send: the same card becomes an approval card; nothing is sent yet
    const writes = fake.writes.length;
    const res = await press(token, 'send');
    expect(res.status).toBe(200);
    view = await t.engine.services.approvals.getByToken(token);
    expect(view.card.kind).toBe('approval');
    expect(view.card.state).toBe('ready');
    expect(view.card.buttons.map((b) => b.label)).toEqual(['Approve with Face ID', 'Not now']);
    expect(view.approval?.challenge).toBeTruthy();
    expect(fake.writes.length).toBe(writes);
    // pressing approve as a button is refused: only Face ID approves
    expect((await press(token, 'approve')).status).toBe(409);
    // after Send the draft is locked: an edit can no longer change what Face ID approves
    const late = await t.engine.app.request(`/v1/cards/by-token/${token}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
      body: JSON.stringify({ text: 'send the money to evil@example.com instead' }),
    });
    expect(late.status).toBe(409);

    // Face ID on the phone: the device signs; only now does the email go
    const id = view.approval?.id as string;
    const row = await t.engine.repos.approvals.get(id);
    const body = await signBody(t, token, u, {
      planSignature: u.keys.sign(planApprovalMessage(id, row?.planHash as string)),
    });
    const ok = await t.engine.app.request(`/v1/approvals/${id}/sign`, {
      method: 'POST',
      headers: {
        authorization: `Card ${token}`,
        'idempotency-key': idemKey(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(ok.status).toBe(200);
    expect(fake.writes.at(-1)).toEqual({
      slug: 'GMAIL_SEND_EMAIL',
      args: {
        recipient_email: 'amara@example.com',
        subject: 'Invoice',
        body: 'Hi Amara, invoice attached. Thanks!',
      },
    });
    expect((await t.engine.services.approvals.getByToken(token)).card.state).toBe('sent');
  });
});

describe('freeze', () => {
  test('"freeze" revokes every key, expires open approvals; the next one says frozen', async () => {
    const f = await enrolledUser(t, '+15554000');
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: f.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: f.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    const signed = await signBody(t, r.cardToken, f);

    expect(freezeCommand('Freeze')).toBe('freeze');
    expect(freezeCommand(' unfreeze! ')).toBe('unfreeze');
    expect(freezeCommand('freeze my card please')).toBeNull();
    const { handleInbound } = await import('../src/inbound.ts');
    const deps = inboundDeps();
    await handleInbound(deps, inbound(f.space.userHandle, 'freeze'));
    expect(t.messaging.texts.at(-1)?.text).toBe(FREEZE_REPLY);

    expect(await t.engine.repos.users.activeDevice(f.userId)).toBeNull();
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('expired');
    expect((await t.engine.services.approvals.getByToken(r.cardToken)).card.state).toBe('expired');
    // the old card can't be approved
    const old = await t.engine.app.request(`/v1/approvals/${r.approvalId}/sign`, {
      method: 'POST',
      headers: {
        authorization: `Card ${r.cardToken}`,
        'idempotency-key': idemKey(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(signed),
    });
    // frozen comes first (423), and the approval itself is already expired
    expect(old.status).toBe(423);
    // the next approval fails with the plain message
    const next = await t.engine.services.approvals.createMoneyApproval({
      userId: f.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: f.space,
    });
    expect(next).toEqual({ decision: 'block', reasons: [FROZEN_TEXT] });
    expect(FROZEN_TEXT).toBe('Penny is frozen. Text unfreeze to start again.');

    // texting "unfreeze" alone never unfreezes: it sends an Unfreeze card
    await handleInbound(deps, inbound(f.space.userHandle, 'unfreeze'));
    expect(t.messaging.texts.at(-1)?.text).toBe(UNFREEZE_REPLY);
    expect(await t.engine.repos.users.activeDevice(f.userId)).toBeNull();
    const ufToken = tokenFromUrl(t.messaging.cards.at(-1)?.card.url);
    const uf = await t.engine.services.approvals.getByToken(ufToken);
    expect(uf.card.type).toBe('unfreeze');
    const challenge = uf.unfreeze?.challenge as string;
    const unfreeze = (body: unknown) =>
      t.engine.app.request(`/v1/cards/by-token/${ufToken}/unfreeze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
        body: JSON.stringify(body),
      });
    // pressing the button is not enough: only Face ID (a signature) unfreezes
    expect((await press(ufToken, 'unfreeze')).status).toBe(409);
    // Face ID on the phone: the frozen device key signs this card's challenge
    const res = await unfreeze({
      deviceId: f.deviceId,
      signature: f.keys.sign(unfreezeMessage(uf.card.id, challenge)),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'unfrozen' });
    expect((await t.engine.repos.users.activeDevice(f.userId))?.id).toBe(f.deviceId);
    // the card is single use
    expect(
      (
        await unfreeze({
          deviceId: f.deviceId,
          signature: f.keys.sign(unfreezeMessage(uf.card.id, challenge)),
        })
      ).status,
    ).toBe(409);
    const after = await t.engine.services.approvals.createMoneyApproval({
      userId: f.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: f.space,
    });
    expect(after.decision).toBe('allow_with_approval');
  });

  test('an Unfreeze card signed with another key fails and keeps Penny frozen', async () => {
    const f = await enrolledUser(t, '+15554002');
    await t.engine.services.approvals.freeze(f.userId);
    expect(await t.engine.services.approvals.startUnfreeze(f.userId, f.space)).toBe('card_sent');
    const token = tokenFromUrl(t.messaging.cards.at(-1)?.card.url);
    const uf = await t.engine.services.approvals.getByToken(token);
    const rogue = (await import('./helpers.ts')).deviceKeys();
    const res = await t.engine.app.request(`/v1/cards/by-token/${token}/unfreeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
      body: JSON.stringify({
        deviceId: f.deviceId,
        signature: rogue.sign(unfreezeMessage(uf.card.id, uf.unfreeze?.challenge as string)),
      }),
    });
    expect(res.status).toBe(422);
    expect((await t.engine.repos.users.byId(f.userId))?.frozenAt).toBeTruthy();
    expect(await t.engine.repos.users.activeDevice(f.userId)).toBeNull();
    // a device the freeze did not switch off (another user's) can't unfreeze either
    const other = await enrolledUser(t, '+15554003');
    expect(await t.engine.services.approvals.startUnfreeze(f.userId, f.space)).toBe('card_sent');
    const token2 = tokenFromUrl(t.messaging.cards.at(-1)?.card.url);
    const uf2 = await t.engine.services.approvals.getByToken(token2);
    const res2 = await t.engine.app.request(`/v1/cards/by-token/${token2}/unfreeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
      body: JSON.stringify({
        deviceId: other.deviceId,
        signature: other.keys.sign(unfreezeMessage(uf2.card.id, uf2.unfreeze?.challenge as string)),
      }),
    });
    expect(res2.status).toBe(422);
    expect((await t.engine.repos.users.byId(f.userId))?.frozenAt).toBeTruthy();
  });

  test('"Not me" on a Blocked card freezes', async () => {
    const f = await enrolledUser(t, '+15554001');
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: f.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '900', to: 'ada.penny.near' },
      space: f.space,
    });
    expect(r.decision).toBe('block');
    const token = tokenFromUrl(t.messaging.cards.at(-1)?.card.url);
    // one tap is not enough: the client must ask "freeze everything?" first
    const first = await press(token, 'notme');
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ error: 'confirm_freeze' });
    expect((await t.engine.repos.users.byId(f.userId))?.frozenAt).toBeNull();
    expect((await press(token, 'notme', true)).status).toBe(200);
    expect((await t.engine.repos.users.byId(f.userId))?.frozenAt).toBeTruthy();
    expect(await t.engine.repos.users.activeDevice(f.userId)).toBeNull();
  });
});

describe('typing', () => {
  test('Penny shows typing for the whole model turn', async () => {
    const { handleInbound } = await import('../src/inbound.ts');
    const f = await enrolledUser(t, '+15554099');
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'x' } }]),
      scriptedModel([{ text: 'hey back' }]),
    );
    const before = t.messaging.typing.length;
    await handleInbound(inboundDeps(), inbound(f.space.userHandle, 'what can you do?'));
    expect(t.messaging.typing.slice(before).map((x) => x.on)).toEqual([true, false]);
  });
});

describe('plain tone', () => {
  test('decorative emoji are removed unless the user sent one first', async () => {
    const { handleInbound } = await import('../src/inbound.ts');
    const f = await enrolledUser(t, '+15554101');
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'x' } }]),
      scriptedModel([{ text: 'on it 🎉' }]),
    );
    await handleInbound(inboundDeps(), inbound(f.space.userHandle, 'what can you do?'));
    expect(t.messaging.texts.at(-1)?.text).toBe('on it');
  });

  test('an emoji from the user is mirrored', async () => {
    const { handleInbound } = await import('../src/inbound.ts');
    const f = await enrolledUser(t, '+15554102');
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'x' } }]),
      scriptedModel([{ text: 'on it 🎉' }]),
    );
    await handleInbound(inboundDeps(), inbound(f.space.userHandle, 'what can you do? 🎉'));
    expect(t.messaging.texts.at(-1)?.text).toBe('on it 🎉');
  });
  test('a long answer lands as a few short texts', async () => {
    const { handleInbound } = await import('../src/inbound.ts');
    const f = await enrolledUser(t, '+15554104');
    const long =
      'mail found three bills this week. nepa is the big one at $84, due friday. the internet bill is $22 and the water bill is $14. if you want, finance can line up all three so you only approve once. otherwise i can remind you the day before each one is due.';
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'x' } }]),
      scriptedModel([{ text: long }]),
    );
    const before = t.messaging.texts.length;
    await handleInbound(inboundDeps(), inbound(f.space.userHandle, 'what bills do i have?'));
    const sent = t.messaging.texts
      .slice(before)
      .map((x) => x.text)
      .filter((x) => x !== WELCOME_TEXT);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.join(' ').replace(/\s+/g, ' ')).toBe(long);
    for (const text of sent) expect(text.length).toBeLessThanOrEqual(240);
  });

  test('a raw connect link never reaches the thread', async () => {
    const { handleInbound } = await import('../src/inbound.ts');
    const f = await enrolledUser(t, '+15554103');
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'x' } }]),
      scriptedModel([{ text: 'tap to connect your gmail (https://connect.example/gmail)' }]),
    );
    await handleInbound(inboundDeps(), inbound(f.space.userHandle, 'connect my gmail'));
    expect(t.messaging.texts.at(-1)?.text).not.toContain('https://');
  });
});

function inboundDeps() {
  const e = t.engine;
  return {
    users: e.repos.users,
    messages: e.repos.messages,
    crew: e.services.crew,
    onboarding: e.services.onboarding,
    messaging: t.messaging,
    userLimiter: { take: () => 0 } as never,
    log: createLogger('silent'),
    approvals: e.services.approvals,
  };
}

let seq = 0;
function inbound(handle: string, text: string) {
  seq += 1;
  return {
    event: 'messages',
    space: { id: `any;-;${handle}`, platform: 'imessage', type: 'dm' },
    message: {
      id: `msg-freeze-${seq}`,
      platform: 'imessage',
      direction: 'inbound',
      timestamp: new Date().toISOString(),
      sender: { id: handle, platform: 'imessage' },
      content: { type: 'text', text },
    },
  } as never;
}
