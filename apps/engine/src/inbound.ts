import type { SpectrumMessagesEvent } from '@penny/shared';
import type { ApprovalService } from './approvals/service.ts';
import type { Crew } from './brain/crew.ts';
import type { EnrollService } from './devices/enroll.ts';
import type { RateLimiter } from './http/security.ts';
import type { Logger } from './lib/logger.ts';
import { toPlainText } from './lib/plain-text.ts';
import type { MessagingPort, SpaceRef } from './ports/messaging.ts';
import type { MessagesRepo } from './repo/bots.ts';
import type { UsersRepo } from './repo/users.ts';

export type InboundDeps = {
  users: UsersRepo;
  messages: MessagesRepo;
  crew: Crew;
  enroll: EnrollService;
  messaging: MessagingPort;
  userLimiter: RateLimiter;
  log: Logger;
  /** Engine public base URL; the no-install setup page lives at /setup on it. */
  publicBaseUrl: string;
  /** Freeze / unfreeze. Absent in a few unit tests. */
  approvals?: ApprovalService;
};

export const WELCOME_TEXT =
  "hey 👋 i'm penny. i help with the everyday stuff — inbox, bills, errands, money, the lot. just talk to me here.";

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
  const conversationId = await d.users.conversationFor(user.id, evt.space.id, evt.space.platform);

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

  const device = await d.users.activeDevice(user.id);
  if (!device) {
    // No install needed to talk to Penny. The first text gets a welcome plus
    // a separate setup link (its own message, nothing to type); after that
    // the crew answers normally. The setup link only matters when an action
    // needs approval.
    const prior = await d.messages.recent(conversationId, user.id, 5);
    const welcomed = prior.some((p) => p.direction === 'outbound');
    if (!welcomed) {
      const { code } = await d.enroll.issue(user.id, m.sender.id);
      const base = d.publicBaseUrl.replace(/\/$/, '');
      await d.messaging.sendText(space, WELCOME_TEXT);
      // A picture link card (no app yet, so never a mini app card). iMessage
      // draws it from /setup's Open Graph tags; the code rides in the fragment.
      await d.messaging.sendText(space, `${base}/setup#code=${code}`);
      await d.messages.add({
        conversationId,
        direction: 'outbound',
        text: 'welcome + setup link [code]',
      });
      return;
    }
    const r = await d.crew.handle(user.id, space, text, { conversationId, enrolled: false });
    const reply = toPlainText(r.text);
    await d.messaging.sendText(space, reply);
    await d.messages.add({ conversationId, direction: 'outbound', text: reply });
    return;
  }

  const r = await d.crew.handle(user.id, space, text, { conversationId, enrolled: true });
  const reply = toPlainText(r.text);
  await d.messaging.sendText(space, reply);
  await d.messages.add({ conversationId, direction: 'outbound', text: reply });
}
