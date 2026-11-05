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
    const { code } = await d.enroll.issue(user.id, m.sender.id);
    const reply = `hey 👋 i'm penny. want me to look after your money? first, install my card on your phone: open the Penny app and enter ${code}. it works once, for 10 minutes.`;
    await d.messaging.sendText(space, reply);
    await d.messages.add({
      conversationId,
      direction: 'outbound',
      text: reply.replace(code, '[code]'),
    });
    return;
  }

  const r = await d.crew.handle(user.id, space, text, { conversationId });
  await d.messaging.sendText(space, r.text);
  await d.messages.add({ conversationId, direction: 'outbound', text: r.text });
}
