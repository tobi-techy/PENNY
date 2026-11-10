import type { ApprovalCard, CardHandle, MessagingPort, SpaceRef } from './messaging.ts';

/**
 * Spectrum cloud iMessage adapter (Photon Stable docs):
 *  - https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing.md
 *  - https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/apps.md
 *
 * Uses the cloud provider package `@spectrum-ts/imessage` (the local provider
 * cannot send iMessage apps). Live cards are customizedMiniApp({ live: true })
 * with a layout (caption, subcaption, trailingCaption, image, imageTitle); state
 * changes edit the same message: space.send(edit(content, sentMessage)).
 *
 * The sent message record (with its mini app session) is needed for edit(), so
 * it is kept in memory keyed by card id. LIMITATION: after a restart an in-place
 * edit is impossible; CardSender falls back to sending a fresh card.
 */

export type SpectrumConfig = {
  projectId: string;
  projectSecret: string;
  appName: string;
  /** PENNY_IMESSAGE_EXT_BUNDLE_ID */
  extensionBundleId: string;
  /** APPLE_TEAM_ID */
  teamId: string;
};

// Minimal structural types so SDK types don't leak through the engine.
type SentMessage = unknown;
type SpectrumSpace = {
  send: (...content: unknown[]) => Promise<SentMessage>;
  startTyping?: () => Promise<void>;
  stopTyping?: () => Promise<void>;
};

export class SpectrumMessaging implements MessagingPort {
  private sent = new Map<string, { space: SpaceRef; message: SentMessage; url: string }>();
  private im: {
    space: { get: (id: string, p?: { phone?: string }) => Promise<SpectrumSpace> };
  } | null = null;
  private sdk: {
    customizedMiniApp: (input: Record<string, unknown>) => unknown;
    richlink: (url: string) => unknown;
    edit: (content: unknown, target: unknown) => unknown;
  } | null = null;

  constructor(private readonly cfg: SpectrumConfig) {}

  private async init() {
    if (this.im && this.sdk) return { im: this.im, sdk: this.sdk };
    const core = await import('spectrum-ts');
    const prov = await import('@spectrum-ts/imessage');
    const app = await core.Spectrum({
      projectId: this.cfg.projectId,
      projectSecret: this.cfg.projectSecret,
      providers: [prov.imessage.config()],
    });
    this.im = prov.imessage(app as never) as unknown as NonNullable<SpectrumMessaging['im']>;
    this.sdk = {
      customizedMiniApp: prov.customizedMiniApp as unknown as (
        i: Record<string, unknown>,
      ) => unknown,
      richlink: core.richlink as unknown as (url: string) => unknown,
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

  /** The exact customizedMiniApp input (exported for tests). */
  static input(cfg: SpectrumConfig, card: ApprovalCard): Record<string, unknown> {
    return {
      appName: cfg.appName,
      extensionBundleId: cfg.extensionBundleId,
      teamId: cfg.teamId,
      live: card.live,
      url: card.url,
      layout: {
        caption: card.caption,
        ...(card.subcaption ? { subcaption: card.subcaption } : {}),
        ...(card.trailingCaption ? { trailingCaption: card.trailingCaption } : {}),
        ...(card.image ? { image: card.image } : {}),
        ...(card.imageTitle ? { imageTitle: card.imageTitle } : {}),
      },
    };
  }

  private content(card: ApprovalCard) {
    const sdk = this.sdk;
    if (!sdk) throw new Error('spectrum not initialised');
    return sdk.customizedMiniApp(SpectrumMessaging.input(this.cfg, card));
  }

  async sendText(ref: SpaceRef, text: string): Promise<void> {
    const s = await this.space(ref);
    await s.send(text);
  }

  /**
   * A URL as iMessage's native link card. Spectrum passes only the URL and the
   * client unfurls it; if that fails, a plain URL message still works.
   */
  async sendLink(ref: SpaceRef, url: string): Promise<void> {
    const { sdk } = await this.init();
    const s = await this.space(ref);
    try {
      await s.send(sdk.richlink(url));
    } catch {
      await s.send(url);
    }
  }

  /** Typing is a nicety: never let a failed indicator block the reply. */
  async startTyping(ref: SpaceRef): Promise<void> {
    try {
      const s = await this.space(ref);
      await s.startTyping?.();
    } catch {
      /* best effort */
    }
  }

  async stopTyping(ref: SpaceRef): Promise<void> {
    try {
      const s = await this.space(ref);
      await s.stopTyping?.();
    } catch {
      /* best effort */
    }
  }

  async sendCard(ref: SpaceRef, card: ApprovalCard): Promise<CardHandle> {
    const s = await this.space(ref);
    const message = await s.send(this.content(card));
    this.sent.set(card.cardId, { space: ref, message, url: card.url });
    return { cardId: card.cardId, ref: card.cardId };
  }

  async editCard(handle: CardHandle, card: ApprovalCard): Promise<void> {
    const prev = this.sent.get(handle.cardId);
    if (!prev) throw new Error('card session not in memory; caller should send a fresh card');
    const { sdk } = await this.init();
    const s = await this.space(prev.space);
    // keep the original URL: the extension keys the bubble by it
    const next = { ...card, url: prev.url };
    await s.send(sdk.edit(this.content(next), prev.message));
  }
}
