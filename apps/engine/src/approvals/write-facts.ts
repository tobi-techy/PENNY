import type { WritePlan } from '@penny/shared';

type Fact = { label: string; value: string };

/** Fields people check first on an outgoing write, in display order. */
const PRIORITY = [
  'to',
  'recipient_email',
  'recipient',
  'recipients',
  'cc',
  'bcc',
  'subject',
  'title',
  'body',
  'message',
  'text',
  'owner',
  'repo',
  'issue_number',
];
const MAX_ARG_FACTS = 5;

// Control characters and bidi overrides could hide or reorder what the card shows.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function show(v: unknown): string {
  const raw = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  const clean = raw.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean || '(empty)';
}

function rank(key: string): number {
  const i = PRIORITY.indexOf(key.toLowerCase());
  return i === -1 ? PRIORITY.length : i;
}

/**
 * Card facts for a write, derived from the exact arguments that will be sent
 * (the payload Face ID seals), never from model-written prose alone. The
 * model's summary is shown last, labelled as Penny's description.
 */
export function writeFacts(plan: WritePlan): Fact[] {
  const facts: Fact[] = [
    { label: 'App', value: show(plan.toolkit) },
    { label: 'Action', value: show(plan.toolSlug) },
  ];
  const keys = Object.keys(plan.arguments).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const k of keys.slice(0, MAX_ARG_FACTS)) {
    facts.push({ label: show(k).slice(0, 40), value: show(plan.arguments[k]) });
  }
  if (keys.length > MAX_ARG_FACTS) {
    facts.push({ label: 'More', value: `${keys.length - MAX_ARG_FACTS} more field(s)` });
  } else {
    facts.push({ label: "Penny's note", value: show(plan.summary) });
  }
  return facts.slice(0, 8);
}
