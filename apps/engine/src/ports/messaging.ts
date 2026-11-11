/**
 * MessagingPort: outbound iMessage. Real adapter = Spectrum cloud iMessage
 * (spectrum-ts, Stable docs). Fake records sends for tests.
 */

export type SpaceRef = { spaceId: string; phone?: string; userHandle: string };

/** A live iMessage-extension card (Spectrum customizedMiniApp, live: true). */
export type ApprovalCard = {
  /** The card this message shows (cards.id). Key for in-place edits. */
  cardId: string;
  url: string; // https://.../a/<cardToken>
  caption: string; // e.g. "Send 0.1 NEAR"
  subcaption?: string; // e.g. "to amara.testnet"
  trailingCaption?: string; // e.g. "1:30 left"
  /** PNG of the card (the same picture the link card uses). */
  image?: Uint8Array;
  imageTitle?: string;
  live: boolean;
};
export type LiveCard = ApprovalCard;

/** Where a live card went. Persisted so a restarted engine can find it again. */
export type CardHandle = { cardId: string; ref: string; space?: SpaceRef };

export interface MessagingPort {
  sendText(space: SpaceRef, text: string): Promise<void>;
  /** Send a URL as a native rich-link card (falls back to the URL as text). */
  sendLink(space: SpaceRef, url: string): Promise<void>;
  /** Best-effort typing indicator; a failure here never breaks a reply. */
  startTyping(space: SpaceRef): Promise<void>;
  stopTyping(space: SpaceRef): Promise<void>;
  sendCard(space: SpaceRef, card: ApprovalCard): Promise<CardHandle>;
  /** Update a previously sent card in place (Spectrum edit()). */
  editCard(handle: CardHandle, card: ApprovalCard): Promise<void>;
}

export class FakeMessaging implements MessagingPort {
  texts: { space: SpaceRef; text: string }[] = [];
  richLinks: { space: SpaceRef; url: string }[] = [];
  typing: { space: SpaceRef; on: boolean }[] = [];
  cards: { space: SpaceRef; card: ApprovalCard }[] = [];
  edits: { handle: CardHandle; card: ApprovalCard }[] = [];

  async sendText(space: SpaceRef, text: string) {
    this.texts.push({ space, text });
  }
  async sendLink(space: SpaceRef, url: string) {
    this.richLinks.push({ space, url });
  }
  async startTyping(space: SpaceRef) {
    this.typing.push({ space, on: true });
  }
  async stopTyping(space: SpaceRef) {
    this.typing.push({ space, on: false });
  }
  /** Set to make the next N edits throw (tests the retry-then-resend path). */
  failEdits = 0;
  editAttempts = 0;

  async sendCard(space: SpaceRef, card: ApprovalCard) {
    this.cards.push({ space, card });
    return { cardId: card.cardId, ref: `fake-card-${this.cards.length}` };
  }
  async editCard(handle: CardHandle, card: ApprovalCard) {
    this.editAttempts += 1;
    if (this.failEdits > 0) {
      this.failEdits -= 1;
      throw new Error('edit failed');
    }
    this.edits.push({ handle, card });
  }
  /** Link cards are plain texts whose URL iMessage turns into a picture card. */
  get links(): { space: SpaceRef; url: string }[] {
    return this.texts
      .filter((t) => /^https:\/\/\S+\/a\/[A-Za-z0-9_-]{43}(\?\S*)?$/.test(t.text))
      .map((t) => ({ space: t.space, url: t.text }));
  }
}
