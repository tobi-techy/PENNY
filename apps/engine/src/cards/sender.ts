import type { Card, CardButton, CardLine, CardState } from '@penny/shared';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import type { ApprovalCard, CardHandle, MessagingPort, SpaceRef } from '../ports/messaging.ts';
import type { CardRow, CardsRepo } from '../repo/cards.ts';
import type { DeviceRow, UsersRepo } from '../repo/users.ts';

/** Info cards stay usable (Undo, Edit) for a day. Approval cards live as long as the approval. */
export const INFO_CARD_TTL_MS = 24 * 60 * 60_000;
/** Live card edits: 3 tries with backoff, then a fresh card. */
export const EDIT_BACKOFF_MS = [200, 800, 2_000] as const;
/** Link cards can't change in place; Penny sends a fresh one for these states only. */
/** Only the outcome of something the user did; an unanswered card expiring sends nothing. */
const LINK_RESEND_STATES: ReadonlySet<CardState> = new Set(['sent', 'blocked', 'failed']);

export type Channel = 'live' | 'link';

/**
 * Card picker. Live (iMessage extension) card only for an active iOS app device
 * that has the extension. Everyone else gets the picture link card. Never a mini
 * app card to someone without the app.
 */
export function pickChannel(device: DeviceRow | null): Channel {
  if (device && !device.revokedAt && device.platform === 'ios_app' && device.hasExtension) {
    return 'live';
  }
  return 'link';
}

export type NewCard = {
  userId: string;
  space: SpaceRef;
  agent: string;
  kind: 'info' | 'approval';
  type: string;
  title: string;
  amount?: string;
  lines: CardLine[];
  buttons: CardButton[];
  state: CardState;
  approvalId?: string;
  expiresAt?: Date;
  /** Server-only data behind the buttons. Never sent to clients. */
  payload?: Record<string, unknown>;
  /** Approval cards reuse the approval's card token (hash only is stored). */
  token?: { token: string; hash: string };
  tokenExpiresAt?: Date;
  /** Live-card bubble lines. Defaults come from the card. */
  subcaption?: string;
  /** Pick the channel from this device instead of the active one (unfreeze cards). */
  forDevice?: DeviceRow | null;
};

export type CardSenderDeps = {
  cards: CardsRepo;
  users: UsersRepo;
  messaging: MessagingPort;
  publicBaseUrl: string;
  log: Logger;
  now: () => Date;
  /** PNG of the card for the live card's layout image. Absent in tests. */
  renderImage?: (card: Card) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
};

export function toCardDto(r: CardRow): Card {
  return {
    id: r.id,
    userId: r.userId,
    agent: r.agent,
    kind: r.kind,
    type: r.type,
    title: r.title,
    ...(r.amount ? { amount: r.amount } : {}),
    lines: r.lines,
    buttons: r.buttons as CardButton[],
    state: r.state as CardState,
    ...(r.approvalId ? { approvalId: r.approvalId } : {}),
    ...(r.expiresAt ? { expiresAt: r.expiresAt.toISOString() } : {}),
    ...(r.receiptUrl ? { receiptUrl: r.receiptUrl } : {}),
    ...(r.statusLine ? { statusLine: r.statusLine } : {}),
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Every agent sends its result through here, so the card picker (live card vs
 * link card) and edit-in-place work the same for all of them.
 */
export class CardSender {
  /** cardId -> live message handle (in memory; after a restart edits fall back to a fresh card). */
  private handles = new Map<string, CardHandle>();
  private linkSends = new Map<string, number>();
  /**
   * cardId -> token, in memory only, so a failed edit or a link update can resend
   * the same URL. Bounded; the DB only ever holds the token's hash.
   */
  private tokens = new Map<string, string>();

  private remember(cardId: string, token: string) {
    this.tokens.set(cardId, token);
    if (this.tokens.size > 5_000) {
      const oldest = this.tokens.keys().next().value;
      if (oldest) this.tokens.delete(oldest);
    }
  }

  constructor(private readonly d: CardSenderDeps) {}

  url(token: string): string {
    return `${this.d.publicBaseUrl.replace(/\/$/, '')}/a/${token}`;
  }

  async send(
    input: NewCard,
  ): Promise<{ card: Card; token: string; url: string; channel: Channel; ref?: string }> {
    const device =
      input.forDevice !== undefined
        ? input.forDevice
        : await this.d.users.activeDevice(input.userId);
    const channel = pickChannel(device ? { ...device, revokedAt: null } : null);
    const tok =
      input.token ??
      (() => {
        const token = randomToken(32);
        return { token, hash: sha256Hex(token) };
      })();
    const now = this.d.now();
    const row = await this.d.cards.create({
      userId: input.userId,
      agent: input.agent,
      kind: input.kind,
      type: input.type,
      title: input.title.slice(0, 80),
      amount: input.amount ?? null,
      lines: input.lines.slice(0, 8),
      buttons: input.buttons.slice(0, 3),
      state: input.state,
      approvalId: input.approvalId ?? null,
      tokenHash: tok.hash,
      tokenExpiresAt:
        input.tokenExpiresAt ?? input.expiresAt ?? new Date(now.getTime() + INFO_CARD_TTL_MS),
      payload: input.payload ?? null,
      channel,
      space: input.space,
      expiresAt: input.expiresAt ?? null,
    });
    const card = toCardDto(row);
    const url = this.url(tok.token);
    this.remember(row.id, tok.token);
    const ref = await this.deliver(row, card, url, input.subcaption, true);
    return { card, token: tok.token, url, channel, ...(ref ? { ref } : {}) };
  }

  /**
   * Change a card. Live cards are edited in place (3 tries with backoff, then a
   * fresh card). Link cards get a fresh link card when the change matters.
   */
  async update(
    cardId: string,
    patch: Parameters<CardsRepo['update']>[1],
    opts: { subcaption?: string; token?: string } = {},
  ): Promise<Card | null> {
    const before = await this.d.cards.get(cardId);
    if (!before) return null;
    // the status line follows the state: a new state without a line clears the old one
    const statusLine =
      opts.subcaption !== undefined
        ? opts.subcaption.slice(0, 120)
        : patch.state && patch.state !== before.state
          ? null
          : undefined;
    const row = await this.d.cards.update(cardId, {
      ...patch,
      ...(statusLine !== undefined ? { statusLine } : {}),
    });
    if (!row) return null;
    const card = toCardDto(row);
    const stateChanged = before.state !== row.state;
    const token = opts.token ?? this.tokens.get(cardId);
    if (row.channel === 'link') {
      if (stateChanged && LINK_RESEND_STATES.has(card.state) && row.space && token) {
        await this.deliver(row, card, this.url(token), opts.subcaption, false);
      } else if (stateChanged && LINK_RESEND_STATES.has(card.state) && row.space) {
        // no token in hand (e.g. the sweeper): say it in words instead
        await this.safeText(row.space, linkUpdateText(card));
      }
      return card;
    }
    await this.editLive(row, card, opts.subcaption, token);
    return card;
  }

  async get(cardId: string): Promise<Card | null> {
    const r = await this.d.cards.get(cardId);
    return r ? toCardDto(r) : null;
  }

  private async liveContent(card: Card, url: string, subcaption?: string): Promise<ApprovalCard> {
    let image: Uint8Array | undefined;
    if (this.d.renderImage) {
      try {
        image = await this.d.renderImage(card);
      } catch (e) {
        this.d.log.warn({ err: (e as Error).name, cardId: card.id }, 'card image failed');
      }
    }
    const trailing = liveTrailing(card, this.d.now());
    return {
      cardId: card.id,
      url,
      caption: card.title,
      subcaption: subcaption ?? liveSubcaption(card),
      ...(trailing ? { trailingCaption: trailing } : {}),
      ...(image ? { image, imageTitle: card.title } : {}),
      live: true,
    };
  }

  private async deliver(
    row: CardRow,
    card: Card,
    url: string,
    subcaption: string | undefined,
    first: boolean,
  ): Promise<string | undefined> {
    const space = row.space;
    if (!space) return undefined;
    if (row.channel === 'link') {
      // iMessage turns the URL into a picture card from the page's Open Graph tags.
      // A version suffix makes iMessage fetch the new picture instead of a cached one.
      const n = (this.linkSends.get(row.id) ?? 0) + 1;
      this.linkSends.set(row.id, n);
      await this.safeText(space, first ? url : `${url}?v=${card.state}-${n}`);
      return undefined;
    }
    try {
      const handle = await this.d.messaging.sendCard(
        space,
        await this.liveContent(card, url, subcaption),
      );
      this.handles.set(row.id, handle);
      // persisted so a restarted engine can still try an in-place edit
      await this.d.cards.update(row.id, { messageRef: handle.ref }).catch(() => null);
      return handle.ref;
    } catch (e) {
      // the live card didn't go out: send the same card as a picture link so the user still gets it
      this.d.log.error(
        { err: (e as Error).message, cardId: row.id },
        'live card failed; sending link',
      );
      await this.safeText(space, url);
      return undefined;
    }
  }

  private async editLive(row: CardRow, card: Card, subcaption?: string, token?: string) {
    const handle =
      this.handles.get(row.id) ??
      (row.messageRef ? { cardId: row.id, ref: row.messageRef } : undefined);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    // The edit keeps the original URL; the url field here is only used for a resend.
    const url = token ? this.url(token) : '';
    if (handle) {
      const content = await this.liveContent(card, url, subcaption);
      for (let i = 0; i < EDIT_BACKOFF_MS.length; i += 1) {
        try {
          await this.d.messaging.editCard(handle, content);
          return;
        } catch (e) {
          this.d.log.warn(
            { err: (e as Error).message, cardId: row.id, attempt: i + 1 },
            'card edit failed',
          );
          if (i < EDIT_BACKOFF_MS.length - 1) await sleep(EDIT_BACKOFF_MS[i] as number);
        }
      }
    }
    // No handle (restart) or every edit failed: a fresh card. Without the token we
    // cannot rebuild the URL, so we say what changed in words. An unanswered card
    // expiring is not worth a new message: it shows Expired when opened.
    if (!LINK_RESEND_STATES.has(card.state)) return;
    if (token && row.space) {
      await this.deliver(row, card, url, subcaption, false);
    } else if (row.space) {
      await this.safeText(row.space, linkUpdateText(card));
    }
  }

  private async safeText(space: SpaceRef, text: string) {
    try {
      await this.d.messaging.sendText(space, text);
    } catch (e) {
      this.d.log.error({ err: (e as Error).message }, 'text send failed');
    }
  }
}

function liveTrailing(card: Card, now: Date): string | undefined {
  if (card.kind === 'approval' && card.state === 'ready' && card.expiresAt) {
    const secs = Math.max(0, Math.floor((Date.parse(card.expiresAt) - now.getTime()) / 1000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left`;
  }
  return undefined;
}

/** Bubble subcaption: the first line, or what to do next. Plain words. */
export function liveSubcaption(card: Card): string {
  switch (card.state) {
    case 'approving':
      return 'approving…';
    case 'sent':
      return 'sent ✓';
    case 'blocked':
      return card.lines[0]?.value ?? 'blocked';
    case 'expired':
      return 'expired. tap for a new card.';
    case 'declined':
      return 'you said no. nothing moved.';
    case 'failed':
      // only the server knows whether anything moved: it sets the exact line
      return card.statusLine ?? "didn't go through.";
    case 'undone':
      return 'undone';
    default: {
      const first = card.lines[0];
      if (!first) return card.kind === 'approval' ? 'tap to approve' : '';
      return first.label ? `${first.label.toLowerCase()} ${first.value}` : first.value;
    }
  }
}

/** When a card can't be redrawn, say what changed in one plain line. */
export function linkUpdateText(card: Card): string {
  switch (card.state) {
    case 'sent':
      return `done: ${card.title.toLowerCase()} went through.`;
    case 'blocked':
      return `blocked: ${card.lines[0]?.value ?? card.title}`;
    case 'failed':
      return `${card.title.toLowerCase()}: ${card.statusLine ?? "didn't go through."}`;
    case 'expired':
      return `${card.title.toLowerCase()} expired. ask me again for a new card.`;
    default:
      return card.title;
  }
}

/** Every user-facing bubble and update line, for the plain-words (jargon) test. */
export function linkSubcaptionStates(): string[] {
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
  const base: Card = {
    id: 'crd_00000000000000000000000000',
    userId: 'u',
    agent: 'penny',
    kind: 'approval',
    type: 'send',
    title: 'Send 1 USDC',
    lines: [{ label: 'To', value: 'ada.testnet' }],
    buttons: [],
    state: 'ready',
    createdAt: new Date(0).toISOString(),
  };
  return states.flatMap((state) => [
    liveSubcaption({ ...base, state }),
    linkUpdateText({ ...base, state }),
  ]);
}
