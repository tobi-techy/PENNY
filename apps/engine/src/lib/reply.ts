/**
 * iMessage rhythm: short bubbles, one thought each. Models still drift into
 * essays, so replies are trimmed and split deterministically before sending.
 * Nothing is dropped: long answers become a few texts instead of a wall.
 */

const DEFAULT_MAX_CHARS = 240;
const DEFAULT_MAX_PARTS = 4;

export type ShapeReplyOptions = {
  /** Soft target for one bubble. Default 240, close to a natural text. */
  maxChars?: number;
  /** Never send more than this many bubbles; the last one takes the rest. */
  maxParts?: number;
};

const LEAD_FILLER =
  /^(?:sure|of course|absolutely|certainly|great question|good question|happy to help|no problem)[,.!:\s-]+/i;
const TAIL_FILLER =
  /\s*(?:let me know if you need anything(?: else)?[.!]*|hope (?:this|that) helps[.!]*|happy to help[.!]*)$/i;

/** Drop the chat-assistant preamble and sign-off that add nothing. */
export function trimFiller(text: string): string {
  let out = text.replace(/\r\n/g, '\n').trim();
  const lead = LEAD_FILLER.exec(out);
  if (lead && out.length > lead[0].length) {
    const rest = out.slice(lead[0].length).trim();
    // "sure, but ..." is a real answer; don't turn it into a bare "but ...".
    if (rest && !/^but\b/i.test(rest)) out = rest;
  }
  return out.replace(TAIL_FILLER, '').trim();
}

function hardSplit(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let buf = '';
  for (const word of text.split(/\s+/)) {
    const next = buf ? `${buf} ${word}` : word;
    if (buf && next.length > maxChars) {
      out.push(buf);
      buf = word;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function units(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const sentence of trimmed.split(/(?<=[.!?…])\s+/)) {
      const s = sentence.trim();
      if (s) out.push(...hardSplit(s, maxChars));
    }
  }
  return out;
}

/** Split one reply into natural bubbles, preserving every word. */
export function splitReply(text: string, opts: ShapeReplyOptions = {}): string[] {
  const maxChars = Math.max(40, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const maxParts = Math.max(1, opts.maxParts ?? DEFAULT_MAX_PARTS);
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const parts: string[] = [];
  let buf = '';
  for (const unit of units(clean, maxChars)) {
    const next = buf ? `${buf} ${unit}` : unit;
    if (buf && next.length > maxChars) {
      parts.push(buf);
      buf = unit;
    } else {
      buf = next;
    }
  }
  if (buf) parts.push(buf);

  if (parts.length <= maxParts) return parts;
  // Keep the bubble count human. The final text carries the rest.
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join(' ')];
}

/** Trim filler, then split. Empty output means there is nothing worth sending. */
export function shapeReply(text: string, opts: ShapeReplyOptions = {}): string[] {
  const trimmed = trimFiller(text);
  return trimmed ? splitReply(trimmed, opts) : [];
}
