import { describe, expect, test } from 'bun:test';
import {
  approvalActionOf,
  approvalHash,
  approvalSignMessage,
  Card,
  cardStyle,
  EnrollBody,
  KNOWN_CARD_TYPES,
  parseCardLenient,
  settledPill,
} from '../src/index.ts';

const base = {
  id: 'crd_01JC0000000000000000000000',
  userId: 'usr_01JC0000000000000000000000',
  agent: 'penny',
  kind: 'info',
  type: 'reminder',
  title: 'Reminder set for 7am',
  lines: [{ label: 'What', value: 'Call mum' }],
  buttons: [{ id: 'undo', label: 'Undo', action: 'undo' }],
  state: 'done',
  createdAt: '2026-11-05T19:00:00.000Z',
};

describe('Card', () => {
  test('a reminder info card parses', () => {
    expect(Card.safeParse(base).success).toBe(true);
  });
  test('every known type has its own style', () => {
    for (const t of KNOWN_CARD_TYPES) expect(cardStyle(t).known).toBe(true);
    // one tag, one meaning: no two types share a label
    const tags = KNOWN_CARD_TYPES.map((t) => cardStyle(t).tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
  test('a finished card is named by what it did', () => {
    expect(settledPill('send')).toBe('Sent');
    expect(settledPill('pay_bill')).toBe('Paid');
    expect(settledPill('new_bot')).toBe('Created');
    expect(settledPill('unfreeze')).toBe('Unfrozen');
    expect(settledPill('found')).toBe('Found');
    expect(settledPill('whatever')).toBe('Done');
  });
  test('an unknown type still parses and gets the plain style', () => {
    const c = Card.parse({ ...base, type: 'weather_report' });
    expect(cardStyle(c.type)).toEqual({ color: '#B1C3D8', tag: '● PENNY', known: false });
  });
  test('lenient parse keeps title and lines from a card with fields we do not know', () => {
    const c = parseCardLenient({ ...base, sparkle: true, buttons: [{ bogus: 1 }] });
    expect(c?.title).toBe('Reminder set for 7am');
    expect(c?.lines).toHaveLength(1);
    expect(c?.buttons).toHaveLength(0);
    expect(parseCardLenient({ lines: [] })).toBeNull();
  });
  test('rejects more than three buttons', () => {
    const b = { id: 'x', label: 'X', action: 'open' };
    expect(Card.safeParse({ ...base, buttons: [b, b, b, b] }).success).toBe(false);
  });
});

describe('approval hash', () => {
  const plan = {
    kind: 'send' as const,
    asset: 'NEAR' as const,
    amount: '0.1',
    to: 'amara.testnet',
  };
  const input = {
    id: 'apr_01JC0000000000000000000000',
    action: approvalActionOf(plan),
    expiresAt: '2026-11-05T19:10:00.000Z',
    planHash: 'q2XfvgGyrVKQkr5xNJARbeL6jLd4uuhW7GN7kX9ObQE',
  };
  test('matches the shared vector', () => {
    expect(approvalHash(input)).toBe('6n_aSpN2MKS6kajO_LbFPNIjj2Zz7mlR5f4WD-H6EFM');
  });
  test('changes when the amount, recipient, id or expiry change', () => {
    const h = approvalHash(input);
    expect(approvalHash({ ...input, action: { ...input.action, amount: '1' } })).not.toBe(h);
    expect(approvalHash({ ...input, action: { ...input.action, to: 'evil.testnet' } })).not.toBe(h);
    expect(approvalHash({ ...input, id: 'apr_01JC0000000000000000000001' })).not.toBe(h);
    expect(approvalHash({ ...input, expiresAt: '2026-11-05T19:11:00.000Z' })).not.toBe(h);
  });
  test('sign message is domain separated', () => {
    expect(approvalSignMessage('h', 'c')).toBe('penny-approval:v2:h:c');
  });
});

describe('EnrollBody platform', () => {
  const ok = { enrollCode: 'ABCDEFGH', publicKeyEd25519: 'A'.repeat(43) };
  test('defaults to the app (no platform field)', () => {
    expect(EnrollBody.safeParse(ok).success).toBe(true);
  });
  test('web_passkey needs a passkey', () => {
    expect(EnrollBody.safeParse({ ...ok, platform: 'web_passkey' }).success).toBe(false);
  });
});
