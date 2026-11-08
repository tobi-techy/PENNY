import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalPill, CardState, cardStyle, KNOWN_CARD_TYPES } from '@penny/shared';
import { sql } from 'drizzle-orm';
import { FROZEN_TEXT } from '../src/approvals/service.ts';
import { stepsFor } from '../src/approvals/state.ts';
import { SETUP_CARD } from '../src/cards/page.ts';
import { cardSentence, trailingFor } from '../src/cards/render.ts';
import { linkSubcaptionStates } from '../src/cards/sender.ts';
import { FakeConnector } from '../src/connectors/composio.ts';
import { FREEZE_REPLY, UNFREEZE_REPLY, WELCOME_TEXT } from '../src/inbound.ts';
import { enrolledUser, idemKey, makeEngine, signBody, type TestEngine } from './helpers.ts';

/**
 * Plain words on every card and message (docs/DESIGN.md section 8). No jargon in
 * user copy: not on cards, not in texts, not in the web pages, not in the iOS UI.
 * Add new user-facing strings here when you add them.
 */
export const JARGON =
  /\b(delegate[ _-]?action|nonce|relayer|relay(ed|ing)?|transactions?|gas|tgas|yocto\w*|borsh|nep-?\d+|max[ _-]?block[ _-]?height|block height|planhash|approvalhash|challenge|webauthn|ed25519|signature)\b/i;

function clean(s: string): string | null {
  const m = JARGON.exec(s);
  return m ? `"${s}" contains "${m[0]}"` : null;
}

let t: TestEngine;
const fake = new FakeConnector();

beforeAll(async () => {
  t = await makeEngine({ connectors: fake, extra: { sleep: async () => {} } });
  const u = await enrolledUser(t);
  await t.db.db.execute(
    sql`update guard_policies set daily_usd = '100000', max_approvals_per_10_min = 100000 where user_id = ${u.userId}`,
  );
  const a = t.engine.services.approvals;
  // A run through the main flows, so every string Penny actually sends is checked.
  const send = await a.createMoneyApproval({
    userId: u.userId,
    bot: null,
    plan: { kind: 'send', asset: 'NEAR', amount: '0.1', to: 'amara.testnet' },
    space: u.space,
    nearUsdPriceMicros: 4_000_000n,
  });
  if (send.decision === 'allow_with_approval') {
    await t.engine.app.request(`/v1/approvals/${send.approvalId}/sign`, {
      method: 'POST',
      headers: {
        authorization: `Card ${send.cardToken}`,
        'idempotency-key': idemKey(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(await signBody(t, send.cardToken, u)),
    });
  }
  // over the limit: Blocked card
  await a.createMoneyApproval({
    userId: u.userId,
    bot: null,
    plan: { kind: 'send', asset: 'USDC', amount: '900', to: 'stranger.near' },
    space: u.space,
  });
  // a failed check: expired + a new card
  const bad = await a.createMoneyApproval({
    userId: u.userId,
    bot: null,
    plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
    space: u.space,
  });
  if (bad.decision === 'allow_with_approval') {
    const body = await signBody(t, bad.cardToken, u);
    await t.engine.app.request(`/v1/approvals/${bad.approvalId}/sign`, {
      method: 'POST',
      headers: {
        authorization: `Card ${bad.cardToken}`,
        'idempotency-key': idemKey(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, signature: 'A'.repeat(86) }),
    });
  }
  // invest, write, declined, expired, freeze
  await a.createInvestApproval({
    userId: u.userId,
    bot: null,
    asset: 'ETH',
    amountUsd: '5',
    space: u.space,
  });
  await a.createWriteApproval({
    userId: u.userId,
    bot: null,
    plan: {
      kind: 'write',
      toolkit: 'gmail',
      toolSlug: 'GMAIL_SEND_EMAIL',
      title: 'Email to Amara',
      summary: 'Invoice',
      arguments: { recipient_email: 'amara@example.com', subject: 'Invoice', body: 'Hi' },
    },
    space: u.space,
  });
  const dec = await a.createMoneyApproval({
    userId: u.userId,
    bot: null,
    plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
    space: u.space,
  });
  if (dec.decision === 'allow_with_approval') await a.decline(dec.approvalId, dec.cardToken);
  t.clock.now = new Date(t.clock.now.getTime() + 11 * 60_000);
  await a.expireDue();
  await a.freeze(u.userId);
  await a.createMoneyApproval({
    userId: u.userId,
    bot: null,
    plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
    space: u.space,
  });
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

describe('no jargon in user copy', () => {
  test('every text and live card Penny sent in the run', () => {
    const out = [
      ...t.messaging.texts.map((x) => x.text).filter((x) => !x.startsWith('https://')),
      ...t.messaging.cards.flatMap((c) => [
        c.card.caption,
        c.card.subcaption ?? '',
        c.card.trailingCaption ?? '',
      ]),
      ...t.messaging.edits.flatMap((c) => [
        c.card.caption,
        c.card.subcaption ?? '',
        c.card.trailingCaption ?? '',
      ]),
    ];
    expect(out.length).toBeGreaterThan(10);
    expect(out.map(clean).filter(Boolean)).toEqual([]);
  });

  test('every card row (title, lines, buttons) and its picture sentence', async () => {
    const rows = (await t.db.db.execute(sql`select id from cards`)) as unknown as {
      rows: { id: string }[];
    };
    const { toCardDto } = await import('../src/cards/sender.ts');
    const bad: string[] = [];
    for (const { id } of rows.rows) {
      const row = await t.engine.repos.cards.get(id);
      if (!row) continue;
      const c = toCardDto(row);
      for (const s of [
        c.title,
        c.amount ?? '',
        ...c.lines.flatMap((l) => [l.label ?? '', l.value]),
        ...c.buttons.map((b) => b.label),
        cardSentence(c, t.clock.now),
      ]) {
        const e = clean(s);
        if (e) bad.push(e);
      }
    }
    expect(rows.rows.length).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  test('fixed copy: replies, pills, tags, steps, bubble lines, setup card', () => {
    const strings = [
      FROZEN_TEXT,
      FREEZE_REPLY,
      UNFREEZE_REPLY,
      WELCOME_TEXT,
      SETUP_CARD.title,
      ...SETUP_CARD.lines.map((l) => l.value),
      ...linkSubcaptionStates(),
      ...CardState.options.map((s) => approvalPill(s) ?? ''),
      ...CardState.options.map((s) => trailingFor({ state: s }, new Date())),
      ...KNOWN_CARD_TYPES.map((k) => cardStyle(k).tag),
      ...(['send', 'invest', 'write', 'create_bot'] as const).flatMap((k) =>
        (['pending', 'signed', 'relayed', 'settled', 'failed'] as const).flatMap((s) =>
          stepsFor(s, k).map((x) => x.label),
        ),
      ),
    ];
    expect(strings.map(clean).filter(Boolean)).toEqual([]);
  });
});

/** String literals from source files, without comments. Good enough for UI copy. */
function literals(file: string): string[] {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|import |export \* from|#if|#endif)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''))
    .join('\n');
  const out: string[] = [];
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|>([^<>{}\n]+)</g)) {
    // Swift \(...) and JS ${...} interpolations are code, not copy
    const s = (m[1] ?? m[2] ?? m[3] ?? '')
      .replace(/\\\((?:[^()]|\([^()]*\))*\)/g, ' ')
      .replace(/\$\{[^}]*\}/g, ' ')
      .trim();
    // user copy has a space or starts uppercase; identifiers, keys and paths don't
    if (s.length > 2 && /\s/.test(s) && !/^[a-z_.\-/:]+$/.test(s)) out.push(s);
  }
  return out;
}

const ROOT = join(import.meta.dir, '..', '..', '..');
const files = (dir: string, ext: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(ext))
    .map((f) => join(ROOT, dir, f));

describe('no jargon in the web pages and the iOS UI', () => {
  test('web: approval and setup pages', () => {
    const bad = files('apps/web/src', '.tsx').flatMap((f) =>
      literals(f).map(clean).filter(Boolean),
    );
    expect(bad).toEqual([]);
  });

  test('iOS: card UI, extension, host app and user-facing errors', () => {
    const swift = [
      ...files('ios/PennyKit/Sources/PennyUI', '.swift'),
      ...files('ios/PennyMessages', '.swift'),
      ...files('ios/PennyHost', '.swift'),
      join(ROOT, 'ios/PennyKit/Sources/PennyCore/Errors.swift'),
    ];
    const bad = swift.flatMap((f) =>
      literals(f)
        // log-only and key-name strings are not shown to people
        .filter((s) => !/^(app\.penny|Penny[A-Z]|NS|com\.apple)/.test(s))
        .map((s) => {
          const e = clean(s);
          return e ? `${f.split('/').at(-1)}: ${e}` : null;
        })
        .filter(Boolean),
    );
    expect(bad).toEqual([]);
  });
});
