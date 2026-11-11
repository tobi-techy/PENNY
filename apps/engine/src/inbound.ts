import type { SpectrumMessagesEvent } from '@penny/shared';
import type { ApprovalService } from './approvals/service.ts';
import type { Crew } from './brain/crew.ts';
import type { RateLimiter } from './http/security.ts';
import type { Logger } from './lib/logger.ts';
import { hasEmoji, stripEmoji, stripExternalLinks, toPlainText, urlsIn } from './lib/plain-text.ts';
import type { OnboardingService } from './onboarding.ts';
import type { MessagingPort, SpaceRef } from './ports/messaging.ts';
import type { MessagesRepo } from './repo/bots.ts';
import type { UsersRepo } from './repo/users.ts';

export type InboundDeps = {
  users: UsersRepo;
  messages: MessagesRepo;
  crew: Crew;
  onboarding: OnboardingService;
  messaging: MessagingPort;
  userLimiter: RateLimiter;
  log: Logger;
  /** Freeze / unfreeze. Absent in a few unit tests. */
  approvals?: ApprovalService;
};

export { WELCOME_TEXT } from './onboarding.ts';

/** User copy for freeze. Plain words; checked by the jargon test. */
export const FREEZE_REPLY =
  "frozen. nothing can move and every open card is cancelled. text unfreeze when you're ready.";
export const UNFREEZE_REPLY = "to unfreeze, confirm it's you with Face ID on the card.";
export const UNFROZEN_REPLY = "unfrozen. there were no keys to switch back on, so you're set.";
export const NOT_FROZEN_REPLY = "penny isn't frozen. you're good.";

/** "freeze" / "unfreeze" are commands, never sent to the model. */
export function freezeCommand(text: string): 'freeze' | 'unfreeze' | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (t === 'freeze' || t === 'freeze penny') return 'freeze';
  if (t === 'unfreeze' || t === 'unfreeze penny') return 'unfreeze';
  return null;
}

/** "connect my gmail" / "link my inbox" / "set up github", but not "disconnect". */
export function connectRequest(text: string): 'gmail' | 'github' | null {
  if (/\b(don'?t|do not|not now|never|disconnect|unlink|remove)\b/i.test(text)) return null;
  if (!/\b(connect|link|hook up|set up)\b/i.test(text)) return null;
  if (/\bgithub\b/i.test(text)) return 'github';
  if (/\bgmail\b|\binbox\b/i.test(text)) return 'gmail';
  return null;
}

/** Handles one verified, deduped Spectrum `messages` event. Runs after the 200 is sent. */
export async function handleInbound(d: InboundDeps, evt: SpectrumMessagesEvent): Promise<void> {
  const m = evt.message;
  if (m.direction !== 'inbound') return;
  const space: SpaceRef = {
    spaceId: evt.space.id,
    userHandle: m.sender.id,
    ...(evt.space.phone ? { phone: evt.space.phone } : {}),
  };
  if (evt.space.type && evt.space.type !== 'dm') return; // v0.1: money talk in DMs only

  const user = await d.users.findOrCreateByHandle(m.sender.id);
  if (d.userLimiter.take(user.id) > 0) {
    d.log.warn({ userId: user.id }, 'user rate limited');
    return;
  }
  const conversationId = await d.users.conversationFor(
    user.id,
    evt.space.id,
    evt.space.platform,
    evt.space.phone ?? null,
  );

  if (m.content.type !== 'text' || typeof m.content.text !== 'string') {
    // reactions, attachments etc: ignore quietly in v0.1
    return;
  }
  const text = m.content.text.slice(0, 4000);
  await d.messages.add({ conversationId, direction: 'inbound', text, externalId: m.id });

  const cmd = d.approvals ? freezeCommand(text) : null;
  if (cmd && d.approvals) {
    let reply = FREEZE_REPLY;
    if (cmd === 'freeze') {
      await d.approvals.freeze(user.id);
    } else {
      // a text alone never unfreezes: Face ID on the Unfreeze card does
      const r = await d.approvals.startUnfreeze(user.id, space);
      reply =
        r === 'card_sent' ? UNFREEZE_REPLY : r === 'unfrozen' ? UNFROZEN_REPLY : NOT_FROZEN_REPLY;
    }
    await d.messaging.sendText(space, reply);
    await d.messages.add({ conversationId, direction: 'outbound', text: reply });
    return;
  }

  // Everyone's first text gets a short welcome; then Penny answers what they
  // actually said (a bare "hi" gets a first thing to try instead). No setup
  // link up front: it goes out on its own when something needs approval.
  const prior = await d.messages.recent(conversationId, user.id, 5);
  if (!prior.some((p) => p.direction === 'outbound')) {
    const answer = await d.onboarding.welcome(space, conversationId, text);
    if (!answer) return;
  }

  const device = await d.users.activeDevice(user.id);
  // iMessage shows Penny typing while the crew thinks. Stops even on a throw.
  const r = await (async () => {
    await d.messaging.startTyping(space);
    try {
      return await d.crew.handle(user.id, space, text, {
        conversationId,
        enrolled: Boolean(device),
      });
    } finally {
      await d.messaging.stopTyping(space);
    }
  })();
  const plain = toPlainText(r.text);
  // The model sometimes answers a connect request from history without calling
  // the tool. Send the card anyway, so the link is a card and not pasted text.
  const asked = connectRequest(text);
  if (asked && !r.toolCalls.includes('connect_app')) {
    try {
      await d.crew.connectApp(user.id, space, asked);
    } catch (e) {
      d.log.warn(
        { userId: user.id, toolkit: asked, err: (e as Error).name },
        'connect card failed',
      );
    }
  }
  // Penny sends links as cards. Never let the model paste an external URL into
  // the thread; only a URL the user just sent is mirrored back.
  const linked = stripExternalLinks(plain, urlsIn(text));
  // Penny mirrors emoji only when the user used one first; otherwise drop them.
  const reply = hasEmoji(text) ? linked : stripEmoji(linked);
  await d.messaging.sendText(space, reply);
  await d.messages.add({ conversationId, direction: 'outbound', text: reply });
  // Background: remember durable facts from this turn. Never delays the reply.
  void d.crew.learnFromTurn(user.id, text);
}
