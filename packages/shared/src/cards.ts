import { z } from 'zod';

/**
 * One card model for everything Penny does or proposes (docs/DESIGN.md section 4).
 * The iMessage extension, the link page and the server-side picture all render
 * this same JSON. Unknown types fall back to a plain card, never an error.
 */

export const CardKind = z.enum(['info', 'approval']);
export type CardKind = z.infer<typeof CardKind>;

/** Known card types: the DESIGN.md table plus the everyday ones. */
export const KNOWN_CARD_TYPES = [
  'invest',
  'pick',
  'send',
  'pay_bill',
  'request',
  'errand',
  'guard_block',
  'checkin',
  'write',
  'new_bot',
  'reminder',
  'email_draft',
  'plan',
  'found',
  'done',
  'unfreeze',
  'connect',
  'setup',
] as const;
export type KnownCardType = (typeof KNOWN_CARD_TYPES)[number];

/** Built-in crew, or a custom bot slug. */
export const CardAgent = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/);

/**
 * What a button does. Small changes (undo, edit, pick, open) never need Face ID.
 * Anything that sends, pays or posts turns the card into an approval card first.
 */
export const CardButtonAction = z.enum([
  'open',
  'edit',
  'undo',
  'pick',
  'send',
  'approve',
  'decline',
  'renew',
  'freeze',
  'unfreeze',
  'pay',
  'dismiss',
]);
export type CardButtonAction = z.infer<typeof CardButtonAction>;

export const CardButton = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
    label: z.string().min(1).max(32),
    action: CardButtonAction,
    /** Open: where it goes. Pick: which option. */
    value: z.string().max(300).optional(),
  })
  .strict();
export type CardButton = z.infer<typeof CardButton>;

/**
 * Card states. Approval cards use ready -> approving -> sent | blocked | expired
 * (plus declined, failed). Info cards are `done` (or `undone` after Undo).
 */
export const CardState = z.enum([
  'ready',
  'approving',
  'sent',
  'done',
  'blocked',
  'expired',
  'declined',
  'failed',
  'undone',
]);
export type CardState = z.infer<typeof CardState>;

export const CardLine = z
  .object({ label: z.string().max(40).optional(), value: z.string().min(1).max(120) })
  .strict();
export type CardLine = z.infer<typeof CardLine>;

export const Card = z
  .object({
    id: z.string().regex(/^crd_[0-9A-HJKMNP-TV-Z]{26}$/),
    userId: z.string().min(3).max(64),
    agent: CardAgent,
    kind: CardKind,
    /** A known type from KNOWN_CARD_TYPES, or anything else (renders as a plain card). */
    type: z.string().min(1).max(32),
    title: z.string().min(1).max(80),
    /** Big number, e.g. "$50.00" or "0.1 NEAR". Optional. */
    amount: z.string().max(40).optional(),
    lines: z.array(CardLine).max(8),
    buttons: z.array(CardButton).max(3),
    state: CardState,
    /** Approval cards link to their Approval record. */
    approvalId: z.string().optional(),
    /** Countdown target for approval cards. */
    expiresAt: z.iso.datetime().optional(),
    /** A plain receipt link once something settled (e.g. the explorer page). */
    receiptUrl: z.url().optional(),
    /** What happened, in one line, exactly as the server knows it (e.g. "couldn't confirm"). */
    statusLine: z.string().max(120).optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type Card = z.infer<typeof Card>;

/** Art colour and mono tag per type. One colour, one meaning. */
const STYLE: Record<KnownCardType, { color: string; tag: string }> = {
  invest: { color: '#6EA1D6', tag: '↗ INVEST' },
  pick: { color: '#6EA1D6', tag: '◇ PICK ONE' },
  send: { color: '#4FD57F', tag: '→ SEND' },
  pay_bill: { color: '#FEA247', tag: '✉ BILL' },
  request: { color: '#B77DF8', tag: '⇄ SPLIT' },
  errand: { color: '#FA78B2', tag: '✦ ERRAND' },
  guard_block: { color: '#FC5855', tag: '■ BLOCKED' },
  checkin: { color: '#8FE4CC', tag: '◎ THIS WEEK' },
  write: { color: '#8B8CF0', tag: '✎ WRITE' },
  new_bot: { color: '#E8C766', tag: '✳ NEW BOT' },
  reminder: { color: '#8FE4CC', tag: '◷ REMINDER' },
  email_draft: { color: '#8B8CF0', tag: '✉ DRAFT' },
  plan: { color: '#B77DF8', tag: '☰ PLAN' },
  found: { color: '#FEA247', tag: '◉ FOUND IT' },
  done: { color: '#4FD57F', tag: '✓ DONE' },
  unfreeze: { color: '#F6A8F0', tag: '◆ UNFREEZE' },
  connect: { color: '#6EA1D6', tag: '⇢ CONNECT' },
  setup: { color: '#6EA1D6', tag: '◈ SET UP' },
};
const PLAIN = { color: '#B1C3D8', tag: '● PENNY' };

export function isKnownCardType(t: string): t is KnownCardType {
  return (KNOWN_CARD_TYPES as readonly string[]).includes(t);
}

export function cardStyle(type: string): { color: string; tag: string; known: boolean } {
  if (isKnownCardType(type)) return { ...STYLE[type], known: true };
  return { ...PLAIN, known: false };
}

/** Crew tile colours (chip on the card). Custom bots get the bot amber. */
export function crewColor(agent: string): string {
  switch (agent) {
    case 'penny':
      return '#FF6B2C';
    case 'invest':
      return '#6CCBFF';
    case 'mail':
      return '#FFE45C';
    case 'guard':
      return '#F6A8F0';
    case 'finance':
      return '#5EE3A1';
    default:
      return '#E8C766';
  }
}

/**
 * What a finished card says it did, in the card's own words. One card type,
 * one outcome: a bot is "Created", a bill is "Paid", a send is "Sent".
 */
export function settledPill(type: string): string {
  switch (type) {
    case 'send':
      return 'Sent';
    case 'invest':
      return 'Bought';
    case 'pay_bill':
      return 'Paid';
    case 'errand':
      return 'Hired';
    case 'write':
    case 'email_draft':
      return 'Sent';
    case 'new_bot':
      return 'Created';
    case 'unfreeze':
      return 'Unfrozen';
    case 'connect':
      return 'Connected';
    case 'setup':
      return 'Set up';
    case 'found':
      return 'Found';
    case 'guard_block':
      return 'Blocked';
    case 'reminder':
    case 'checkin':
    case 'request':
    case 'pick':
    case 'plan':
    case 'done':
      return 'Done';
    default:
      return 'Done';
  }
}

/** The pill label for a state on an approval card. Plain words. */
export function approvalPill(state: CardState): string | null {
  switch (state) {
    case 'ready':
      return 'Approve with Face ID';
    case 'approving':
      return 'Approving…';
    case 'sent':
      return 'Sent';
    case 'expired':
      return 'Get a new card';
    case 'blocked':
      return 'Not me';
    default:
      return null;
  }
}

/**
 * Lenient parse for clients: a card from a newer engine with fields we don't know
 * still renders. Returns null only when the basics (title) are missing.
 */
export function parseCardLenient(raw: unknown): Card | null {
  const strict = Card.safeParse(raw);
  if (strict.success) return strict.data;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title) return null;
  const lines = Array.isArray(r.lines)
    ? r.lines.flatMap((l) => {
        const p = CardLine.safeParse(l);
        return p.success ? [p.data] : [];
      })
    : [];
  const buttons = Array.isArray(r.buttons)
    ? r.buttons.flatMap((b) => {
        const p = CardButton.safeParse(b);
        return p.success ? [p.data] : [];
      })
    : [];
  const state = CardState.safeParse(r.state);
  return {
    id: typeof r.id === 'string' ? r.id : 'crd_00000000000000000000000000',
    userId: typeof r.userId === 'string' ? r.userId : 'unknown',
    agent: typeof r.agent === 'string' && CardAgent.safeParse(r.agent).success ? r.agent : 'penny',
    kind: r.kind === 'approval' ? 'approval' : 'info',
    type: typeof r.type === 'string' && r.type ? r.type.slice(0, 32) : 'plain',
    title: r.title.slice(0, 80),
    lines: lines.slice(0, 8),
    buttons: buttons.slice(0, 3),
    state: state.success ? state.data : 'done',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
  };
}

// ---------- approval by card token (extension + link page) ----------

export const ApprovalByTokenResponse = z.object({
  card: Card,
  /** Unfreeze cards: the single-use challenge to sign (app) or answer with a passkey (web). */
  unfreeze: z
    .object({ challenge: z.string(), passkeys: z.array(z.string()).optional() })
    .optional(),
  approval: z
    .object({
      id: z.string(),
      action: z.object({ type: z.string(), to: z.string(), amount: z.string(), asset: z.string() }),
      approvalHash: z.string(),
      /** base64url of 32 random bytes; single use. Absent once used, expired or not pending. */
      challenge: z.string().optional(),
      expiresAt: z.iso.datetime(),
      status: z.string(),
      /** Web passkey credential ids for this user (link page only). */
      passkeys: z.array(z.string()).optional(),
      /** The full approval (NEAR actions, nonce, max block height) the device signs over. */
      detail: z.unknown(),
    })
    .optional(),
});
export type ApprovalByTokenResponse = z.infer<typeof ApprovalByTokenResponse>;

const Base64UrlStr = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** POST /v1/approvals/:id/sign (iOS app). */
export const SignBody = z
  .object({
    deviceId: z.string().min(3).max(64),
    /** ed25519 over approvalSignMessage(approvalHash, challenge), base64url. */
    signature: Base64UrlStr.length(86),
    /** Money: base64 borsh SignedDelegateAction. Write/new bot: planSignature. */
    signedDelegateAction: z.string().min(4).max(16_384).optional(),
    planSignature: Base64UrlStr.length(86).optional(),
  })
  .strict();
export type SignBody = z.infer<typeof SignBody>;

/** POST /v1/approvals/:id/passkey (link page). The assertion is the WebAuthn JSON form. */
export const PasskeyAssertion = z
  .object({
    id: Base64UrlStr.max(1024),
    rawId: Base64UrlStr.max(1024),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: Base64UrlStr.max(4096),
        authenticatorData: Base64UrlStr.max(4096),
        signature: Base64UrlStr.max(1024),
        userHandle: Base64UrlStr.max(512).optional(),
      })
      .strict(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().max(32).optional(),
  })
  .strict();
export type PasskeyAssertion = z.infer<typeof PasskeyAssertion>;

export const PasskeyApproveBody = z
  .object({
    assertion: PasskeyAssertion,
    signedDelegateAction: z.string().min(4).max(16_384).optional(),
    planSignature: Base64UrlStr.length(86).optional(),
  })
  .strict();
export type PasskeyApproveBody = z.infer<typeof PasskeyApproveBody>;

/** Registration response from navigator.credentials.create (WebAuthn JSON form). */
export const PasskeyRegistration = z
  .object({
    id: Base64UrlStr.max(1024),
    rawId: Base64UrlStr.max(1024),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: Base64UrlStr.max(4096),
        attestationObject: Base64UrlStr.max(16_384),
        transports: z.array(z.string().max(32)).max(8).optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: Base64UrlStr.max(4096).optional(),
        authenticatorData: Base64UrlStr.max(4096).optional(),
      })
      .strict(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().max(32).optional(),
  })
  .strict();
export type PasskeyRegistration = z.infer<typeof PasskeyRegistration>;

export const CardPressBody = z
  .object({
    buttonId: z.string().max(24),
    /** "Not me" freezes everything: the client must ask and send confirm: true. */
    confirm: z.boolean().optional(),
  })
  .strict();

/** POST /v1/cards/by-token/:token/unfreeze: Face ID from the phone, or a passkey from the web. */
export const UnfreezeBody = z.union([
  z.object({ deviceId: z.string().min(3).max(64), signature: Base64UrlStr.length(86) }).strict(),
  z.object({ assertion: PasskeyAssertion }).strict(),
]);
export type UnfreezeBody = z.infer<typeof UnfreezeBody>;

/** The message the device key signs to unfreeze. */
export function unfreezeMessage(cardId: string, challenge: string): string {
  return `penny-unfreeze:v1:${cardId}:${challenge}`;
}
