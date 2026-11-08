/**
 * The card JSON the engine sends (packages/shared Card), and how the page shows it.
 * Same design as the iMessage card and the server picture (docs/DESIGN.md section 4).
 * Unknown types fall back to a plain card; nothing here throws on a card it doesn't know.
 */

export type CardLine = { label?: string; value: string };
export type CardButton = { id: string; label: string; action: string; value?: string };
export type CardState =
  | 'ready'
  | 'approving'
  | 'sent'
  | 'done'
  | 'blocked'
  | 'expired'
  | 'declined'
  | 'failed'
  | 'undone';

export type CardJson = {
  id: string;
  agent: string;
  kind: 'info' | 'approval';
  type: string;
  title: string;
  amount?: string;
  lines: CardLine[];
  buttons: CardButton[];
  state: CardState;
  approvalId?: string;
  expiresAt?: string;
  receiptUrl?: string;
  /** What happened, as the server knows it ("couldn't confirm…"). Shown as is. */
  statusLine?: string;
};

export type ApprovalView = {
  id: string;
  action: { type: string; to: string; amount: string; asset: string };
  approvalHash: string;
  challenge?: string;
  expiresAt: string;
  status: string;
  passkeys?: string[];
  detail: unknown;
};

export type ByToken = { card: CardJson; approval?: ApprovalView };

const STYLE: Record<string, { color: string; tag: string }> = {
  invest: { color: '#6EA1D6', tag: 'INVEST' },
  pick: { color: '#6EA1D6', tag: 'PICK ONE' },
  send: { color: '#4FD57F', tag: 'SEND' },
  pay_bill: { color: '#FEA247', tag: 'BILL' },
  request: { color: '#B77DF8', tag: 'SPLIT' },
  errand: { color: '#FA78B2', tag: 'ERRAND' },
  guard_block: { color: '#FC5855', tag: 'BLOCKED' },
  checkin: { color: '#8FE4CC', tag: 'THIS WEEK' },
  write: { color: '#8B8CF0', tag: 'WRITE' },
  new_bot: { color: '#E8C766', tag: 'NEW BOT' },
  reminder: { color: '#8FE4CC', tag: 'REMINDER' },
  email_draft: { color: '#8B8CF0', tag: 'DRAFT' },
  plan: { color: '#B77DF8', tag: 'PLAN' },
  found: { color: '#FEA247', tag: 'FOUND IT' },
  done: { color: '#4FD57F', tag: 'DONE' },
};

export function styleFor(type: string): { color: string; tag: string; known: boolean } {
  const s = STYLE[type];
  return s ? { ...s, known: true } : { color: '#B1C3D8', tag: 'PENNY', known: false };
}

/** The main pill on an approval card, plain words. */
export function pillFor(state: CardState): string | null {
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

export function closingLine(state: CardState): string | null {
  switch (state) {
    case 'sent':
      return 'Done. It went through.';
    case 'blocked':
      return null;
    case 'expired':
      return 'This card ran out of time. Nothing moved.';
    case 'declined':
      return 'You said no. Nothing moved.';
    case 'failed':
      // only the server knows whether anything moved; its statusLine says so when it can
      return "It didn't go through.";
    case 'undone':
      return 'Undone.';
    default:
      return null;
  }
}

/** "1:30 left" for a live approval card. */
export function countdown(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return '';
  const secs = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left`;
}

/** Tolerant read of a card: a newer engine's card still shows title and lines. */
export function readCard(raw: unknown): CardJson | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title) return null;
  const lines = Array.isArray(r.lines)
    ? r.lines.filter((l): l is CardLine => !!l && typeof (l as CardLine).value === 'string')
    : [];
  const buttons = Array.isArray(r.buttons)
    ? r.buttons.filter(
        (b): b is CardButton =>
          !!b &&
          typeof (b as CardButton).id === 'string' &&
          typeof (b as CardButton).label === 'string',
      )
    : [];
  const states: CardState[] = [
    'ready',
    'approving',
    'sent',
    'done',
    'blocked',
    'expired',
    'declined',
    'failed',
    'undone',
  ];
  const state = states.includes(r.state as CardState) ? (r.state as CardState) : 'done';
  return {
    id: typeof r.id === 'string' ? r.id : '',
    agent: typeof r.agent === 'string' ? r.agent : 'penny',
    kind: r.kind === 'approval' ? 'approval' : 'info',
    type: typeof r.type === 'string' ? r.type : 'plain',
    title: r.title,
    ...(typeof r.amount === 'string' ? { amount: r.amount } : {}),
    lines: lines.slice(0, 8),
    buttons: buttons.slice(0, 3),
    state,
    ...(typeof r.approvalId === 'string' ? { approvalId: r.approvalId } : {}),
    ...(typeof r.expiresAt === 'string' ? { expiresAt: r.expiresAt } : {}),
    ...(typeof r.statusLine === 'string' ? { statusLine: r.statusLine.slice(0, 120) } : {}),
    ...(typeof r.receiptUrl === 'string' && r.receiptUrl.startsWith('https://')
      ? { receiptUrl: r.receiptUrl }
      : {}),
  };
}

/** The 43-char card token from /a/<token>. */
export function tokenFromPath(path: string): string | null {
  const m = /^\/a\/([A-Za-z0-9_-]{43})\/?$/.exec(path);
  return m?.[1] ?? null;
}
