import type { SpectrumMessagesEvent } from '@penny/shared';
import type { Crew } from './brain/crew.ts';
import type { RateLimiter } from './http/security.ts';
import type { Logger } from './lib/logger.ts';
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
  await d.messaging.sendText(space, r.text);
  await d.messages.add({ conversationId, direction: 'outbound', text: r.text });
}
