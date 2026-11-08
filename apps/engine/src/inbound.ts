import type { SpectrumMessagesEvent } from '@penny/shared';
import type { ApprovalService } from './approvals/service.ts';
import type { Crew } from './brain/crew.ts';
import type { RateLimiter } from './http/security.ts';
import type { Logger } from './lib/logger.ts';
import { toPlainText } from './lib/plain-text.ts';
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
export const UNFREEZE_REPLY = "unfrozen. you're back. ask me again for anything you need.";
export const UNFREEZE_CARD_REPLY =
  'to unfreeze, approve the card i just sent on the phone or browser you set up penny with.';
export const NOT_FROZEN_REPLY = "you're not frozen. all good.";
export const UNFREEZE_FAILED_REPLY =
  "hmm, i couldn't send the unfreeze card. try again in a minute.";

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
    if (cmd === 'freeze') await d.approvals.freeze(user.id);
    else {
      // Never unfreeze on a text alone: the card can only be approved on the device
      // the user set up, which whoever holds the thread doesn't have.
      const r = await d.approvals.requestUnfreeze(user.id, space);
      reply =
        r === 'card_sent'
          ? UNFREEZE_CARD_REPLY
          : r === 'unfrozen'
            ? UNFREEZE_REPLY
            : r === 'not_frozen'
              ? NOT_FROZEN_REPLY
              : UNFREEZE_FAILED_REPLY;
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
  const r = await d.crew.handle(user.id, space, text, {
    conversationId,
    enrolled: Boolean(device),
  });
  const reply = toPlainText(r.text);
  await d.messaging.sendText(space, reply);
  await d.messages.add({ conversationId, direction: 'outbound', text: reply });
}
