import type { DemoRepo } from '../repo/demo.ts';
import type { ApprovalCard, CardHandle, MessagingPort, SpaceRef } from './messaging.ts';

/**
 * The public demo's transport. Instead of Spectrum iMessage it writes the same
 * outbound traffic into demo_messages, so a judge sees exactly what the phone would
 * have seen: Penny's bubbles and the same /a/<token> card the link channel sends.
 *
 * Every demo space is `demo;<sessionId>`. DemoAwareMessaging routes those here and
 * everything else to the real port, so one engine can serve both.
 */
export const DEMO_SPACE_PREFIX = 'demo;';

export const demoSpaceId = (sessionId: string): string => `${DEMO_SPACE_PREFIX}${sessionId}`;

export function demoSessionOf(spaceId: string): string | null {
  return spaceId.startsWith(DEMO_SPACE_PREFIX) ? spaceId.slice(DEMO_SPACE_PREFIX.length) : null;
}

/** /a/<43-char token>, optionally versioned so iMessage refetches the picture. */
const CARD_URL = /^(https:\/\/[^\s]+\/a\/([A-Za-z0-9_-]{43}))(?:\?v=[\w-]+)?$/;

export function cardTokenOf(text: string): { url: string; token: string } | null {
  const m = CARD_URL.exec(text.trim());
  return m?.[1] && m[2] ? { url: m[1], token: m[2] } : null;
}

export class DemoMessaging implements MessagingPort {
  constructor(private readonly demo: DemoRepo) {}

  async sendText(space: SpaceRef, text: string): Promise<void> {
    const session = demoSessionOf(space.spaceId);
    if (!session) return;
    // The link channel sends a card as its URL. Keep it structured: the page renders
    // the card inline and never makes a judge read a URL.
    const card = cardTokenOf(text);
    if (card) await this.demo.add(session, { direction: 'outbound', kind: 'card', url: card.url });
    else await this.demo.add(session, { direction: 'outbound', kind: 'text', text });
  }

  async sendLink(space: SpaceRef, url: string): Promise<void> {
    await this.sendText(space, url);
  }

  /**
   * No typing rows: the page shows the indicator for as long as its /say request is
   * open, which is exactly the window the phone would show it. Persisting typing
   * frames would leave stale bubbles in a reloaded thread.
   */
  async startTyping(_space: SpaceRef): Promise<void> {}
  async stopTyping(_space: SpaceRef): Promise<void> {}

  /** Never reached for web_passkey users (pickChannel -> link); kept for parity. */
  async sendCard(space: SpaceRef, card: ApprovalCard): Promise<CardHandle> {
    const session = demoSessionOf(space.spaceId);
    if (session)
      await this.demo.add(session, {
        direction: 'outbound',
        kind: 'card',
        url: card.url,
        cardId: card.cardId,
      });
    return { cardId: card.cardId, ref: `demo-${card.cardId}` };
  }

  async editCard(_handle: CardHandle, _card: ApprovalCard): Promise<void> {
    // web_passkey users are on the link channel, which re-sends a URL instead of
    // editing in place; CardSender never calls this for them.
  }
}

/** Routes demo spaces to the demo port and every other space to the live one. */
export class DemoAwareMessaging implements MessagingPort {
  constructor(
    private readonly inner: MessagingPort,
    private readonly demo: DemoMessaging,
  ) {}

  private port(space: SpaceRef): MessagingPort {
    return demoSessionOf(space.spaceId) ? this.demo : this.inner;
  }

  sendText(space: SpaceRef, text: string) {
    return this.port(space).sendText(space, text);
  }
  sendLink(space: SpaceRef, url: string) {
    return this.port(space).sendLink(space, url);
  }
  startTyping(space: SpaceRef) {
    return this.port(space).startTyping(space);
  }
  stopTyping(space: SpaceRef) {
    return this.port(space).stopTyping(space);
  }
  sendCard(space: SpaceRef, card: ApprovalCard) {
    return this.port(space).sendCard(space, card);
  }
  editCard(handle: CardHandle, card: ApprovalCard) {
    // A handle carries its space when it came from the DB (a restarted engine).
    return handle.space && demoSessionOf(handle.space.spaceId)
      ? this.demo.editCard(handle, card)
      : this.inner.editCard(handle, card);
  }
}
