import type { ApprovalCard, CardHandle, MessagingPort, SpaceRef } from './messaging.ts';

/**
 * Spectrum cloud iMessage adapter (Photon Stable docs):
 *  - https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing.md
 *  - https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/apps.md
 *
 * Webhooks carry no send capability, so replies go through a long-lived
 * Spectrum() instance: imessage(app).space.get(spaceId) then space.send(...).
 * Cards: customizedMiniApp({ live: true, ... }); updates: space.send(edit(card, sentMessage)).
 *
 * The sent message record holds the miniAppCardSession needed for edit(), so
 * it is kept in memory keyed by approvalId. LIMITATION: after a restart an
 * in-place edit is impossible; we fall back to sending a new card.
 */

export type SpectrumConfig = {
  projectId: string;
  projectSecret: string;
  appName: string;
  extensionBundleId: string;
  teamId: string;
};

// Minimal structural types so we don't leak SDK types through the engine.
type SentMessage = unknown;
type SpectrumSpace = { send: (...content: unknown[]) => Promise<SentMessage> };

export class SpectrumMessaging implements MessagingPort {
  private sent = new Map<string, { space: SpaceRef; message: SentMessage }>();
  private im: {
    space: { get: (id: string, p?: { phone?: string }) => Promise<SpectrumSpace> };
  } | null = null;
  private sdk: {
    customizedMiniApp: (input: Record<string, unknown>) => unknown;
    edit: (content: unknown, target: unknown) => unknown;
  } | null = null;

  constructor(private readonly cfg: SpectrumConfig) {}

  private async init() {
    if (this.im && this.sdk) return { im: this.im, sdk: this.sdk };
    const core = await import('spectrum-ts');
    const prov = await import('spectrum-ts/providers/imessage');
    const app = await core.Spectrum({
      projectId: this.cfg.projectId,
      projectSecret: this.cfg.projectSecret,
      providers: [prov.imessage.config()],
    });
    this.im = prov.imessage(app) as unknown as NonNullable<SpectrumMessaging['im']>;
    this.sdk = {
      customizedMiniApp: prov.customizedMiniApp as unknown as (
        i: Record<string, unknown>,
      ) => unknown,
      edit: core.edit as unknown as (c: unknown, t: unknown) => unknown,
    };
    return { im: this.im, sdk: this.sdk };
  }

  private async space(ref: SpaceRef): Promise<SpectrumSpace> {
    const { im } = await this.init();
    return im.space.get(
      ref.spaceId,
      ref.phone && ref.phone !== 'shared' ? { phone: ref.phone } : undefined,
    );
  }

  private content(card: ApprovalCard) {
    const sdk = this.sdk;
    if (!sdk) throw new Error('spectrum not initialised');
    return sdk.customizedMiniApp({
      appName: this.cfg.appName,
      extensionBundleId: this.cfg.extensionBundleId,
      teamId: this.cfg.teamId,
      live: card.live,
      url: card.url,
      layout: {
        caption: card.caption,
        ...(card.subcaption ? { subcaption: card.subcaption } : {}),
        ...(card.trailingCaption ? { trailingCaption: card.trailingCaption } : {}),
      },
    });
  }

  async sendText(ref: SpaceRef, text: string): Promise<void> {
    const s = await this.space(ref);
    await s.send(text);
  }

  async sendCard(ref: SpaceRef, card: ApprovalCard): Promise<CardHandle> {
    const s = await this.space(ref);
    const message = await s.send(this.content(card));
    this.sent.set(card.approvalId, { space: ref, message });
    return { approvalId: card.approvalId, ref: card.approvalId };
  }

  async editCard(handle: CardHandle, card: ApprovalCard): Promise<void> {
    const prev = this.sent.get(handle.approvalId);
    if (!prev) throw new Error('card session not in memory; caller should send a fresh card');
    const { sdk } = await this.init();
    const s = await this.space(prev.space);
    await s.send(sdk.edit(this.content(card), prev.message));
  }
}
