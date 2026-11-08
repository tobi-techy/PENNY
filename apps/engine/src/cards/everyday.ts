import type { Card, WritePlan } from '@penny/shared';
import type { SpaceRef } from '../ports/messaging.ts';
import type { RemindersRepo } from '../repo/cards.ts';
import type { CardSender } from './sender.ts';

/**
 * Everyday jobs that end in an info card: a reminder set, an email drafted.
 * No Face ID: nothing leaves Penny until a button that sends turns the card
 * into an approval card (CardActions).
 */

/** "7am", "7:30pm" from the clock time the user meant (the ISO string's own offset). */
export function clockLabel(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const h = Number(m[1]);
  const min = m[2] as string;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === '00' ? `${h12}${suffix}` : `${h12}:${min}${suffix}`;
}

/** Body characters a draft card can show (6 lines of 120). Edits may never go past it. */
export const DRAFT_VISIBLE_CHARS = 720;

/** Card lines for an email draft: To, Subject, then the body as it will be sent. */
export function draftLines(toEmail: string, subject: string, body: string) {
  const chunks: string[] = [];
  const shown = body.slice(0, DRAFT_VISIBLE_CHARS);
  for (let i = 0; i < shown.length; i += 120) chunks.push(shown.slice(i, i + 120));
  const rest = body.length - shown.length;
  if (rest > 0) {
    chunks.splice(5);
    chunks.push(`…and ${rest + (DRAFT_VISIBLE_CHARS - 600)} more characters`);
  }
  return [
    { label: 'To', value: toEmail.slice(0, 120) },
    { label: 'Subject', value: (subject || '(no subject)').slice(0, 120) },
    ...(chunks.length ? chunks.map((value) => ({ value })) : [{ value: '(empty)' }]),
  ];
}

export async function setReminder(
  d: { reminders: RemindersRepo; cards: CardSender; now: () => Date },
  input: { userId: string; space: SpaceRef; agent: string; text: string; dueAt: string },
): Promise<{ ok: true; card: Card } | { ok: false; error: string }> {
  const due = new Date(input.dueAt);
  if (Number.isNaN(due.getTime())) return { ok: false, error: 'When should I remind you?' };
  if (due.getTime() < d.now().getTime() - 60_000) {
    return { ok: false, error: "That time's already gone. When should I remind you?" };
  }
  const r = await d.reminders.create({
    userId: input.userId,
    text: input.text.slice(0, 200),
    dueAt: due,
    space: input.space,
  });
  const { card } = await d.cards.send({
    userId: input.userId,
    space: input.space,
    agent: input.agent,
    kind: 'info',
    type: 'reminder',
    title: `Reminder set for ${clockLabel(input.dueAt)}`,
    lines: [{ label: 'What', value: input.text.slice(0, 120) }],
    buttons: [{ id: 'undo', label: 'Undo', action: 'undo' }],
    state: 'done',
    payload: { reminderId: r.id },
  });
  await d.reminders.setCard(r.id, card.id);
  return { ok: true, card };
}

export async function draftEmail(
  d: { cards: CardSender },
  input: {
    userId: string;
    space: SpaceRef;
    agent: string;
    botId: string | null;
    toName: string;
    toEmail: string;
    subject: string;
    body: string;
  },
): Promise<{ ok: true; card: Card }> {
  const plan: WritePlan = {
    kind: 'write',
    toolkit: 'gmail',
    toolSlug: 'GMAIL_SEND_EMAIL',
    title: `Email to ${input.toName}`.slice(0, 80),
    summary: input.subject.slice(0, 300) || 'An email',
    arguments: { recipient_email: input.toEmail, subject: input.subject, body: input.body },
  };
  const { card } = await d.cards.send({
    userId: input.userId,
    space: input.space,
    agent: input.agent,
    kind: 'info',
    type: 'email_draft',
    title: `Email to ${input.toName} ready`.slice(0, 80),
    lines: draftLines(input.toEmail, input.subject, input.body),
    buttons: [
      { id: 'send', label: 'Send', action: 'send' },
      { id: 'edit', label: 'Edit', action: 'edit' },
    ],
    state: 'done',
    payload: { writePlan: plan, botId: input.botId },
  });
  return { ok: true, card };
}
