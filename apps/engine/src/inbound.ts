import type { SpectrumMessagesEvent } from '@penny/shared';
import type { Crew } from './brain/crew.ts';
import type { EnrollService } from './devices/enroll.ts';
import type { RateLimiter } from './http/security.ts';
import type { Logger } from './lib/logger.ts';
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
};

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
      await d.messaging.sendText(
        space,
        `hey 👋 i'm penny. i help with the everyday stuff — inbox, bills, errands, money, the lot. just talk to me here.`,
      );
      await d.messaging.sendText(space, `${base}/setup#code=${code}`);
      await d.messages.add({
        conversationId,
        direction: 'outbound',
        text: 'welcome + setup link [code]',
      });
      return;
    }
    const r = await d.crew.handle(user.id, space, text, { conversationId, enrolled: false });
    await d.messaging.sendText(space, r.text);
    await d.messages.add({ conversationId, direction: 'outbound', text: r.text });
    return;
  }

  const r = await d.crew.handle(user.id, space, text, { conversationId, enrolled: true });
  await d.messaging.sendText(space, r.text);
  await d.messages.add({ conversationId, direction: 'outbound', text: r.text });
}
