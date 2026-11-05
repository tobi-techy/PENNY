/**
 * MessagingPort: outbound iMessage. Real adapter = Spectrum cloud iMessage
 * (spectrum-ts, Stable docs). Fake records sends for tests.
 */

export type SpaceRef = { spaceId: string; phone?: string; userHandle: string };

export type ApprovalCard = {
  approvalId: string;
  url: string; // https://.../a/<approvalId>#t=<cardToken>
  caption: string; // e.g. "Swap · USDC → ETH Momentum"
  subcaption?: string; // e.g. "$50.00 · tap to approve"
  trailingCaption?: string;
  live: boolean;
};

export type CardHandle = { approvalId: string; ref: string };

export interface MessagingPort {
  sendText(space: SpaceRef, text: string): Promise<void>;
  sendCard(space: SpaceRef, card: ApprovalCard): Promise<CardHandle>;
  /** Update a previously sent card in place (Spectrum edit()). */
  editCard(handle: CardHandle, card: ApprovalCard): Promise<void>;
}

export class FakeMessaging implements MessagingPort {
  texts: { space: SpaceRef; text: string }[] = [];
  cards: { space: SpaceRef; card: ApprovalCard }[] = [];
  edits: { handle: CardHandle; card: ApprovalCard }[] = [];

  async sendText(space: SpaceRef, text: string) {
    this.texts.push({ space, text });
  }
  async sendCard(space: SpaceRef, card: ApprovalCard) {
    this.cards.push({ space, card });
    return { approvalId: card.approvalId, ref: `fake-card-${this.cards.length}` };
  }
  async editCard(handle: CardHandle, card: ApprovalCard) {
    this.edits.push({ handle, card });
  }
}
