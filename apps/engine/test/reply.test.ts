import { describe, expect, test } from 'bun:test';
import { shapeReply, splitReply, trimFiller } from '../src/lib/reply.ts';

describe('reply shape', () => {
  test('a short reply stays one text', () => {
    expect(shapeReply('done. mail has two bills for you.')).toEqual([
      'done. mail has two bills for you.',
    ]);
  });

  test('assistant preamble and sign-off are dropped', () => {
    expect(trimFiller('Sure, done. Let me know if you need anything else.')).toBe('done.');
    expect(trimFiller('Of course! The card is ready. Hope this helps.')).toBe('The card is ready.');
    // "sure, but" is a real answer, not filler.
    expect(trimFiller('sure, but guard says no')).toBe('sure, but guard says no');
  });

  test('a long reply becomes a few short texts, with nothing lost', () => {
    const long =
      'mail found three bills this week. nepa is the big one at $84, due friday. the internet bill is $22 and the water bill is $14. if you want, finance can line up all three so you only approve once. otherwise i can remind you the day before each one is due.';
    const parts = shapeReply(long, { maxChars: 120, maxParts: 4 });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(4);
    for (const p of parts.slice(0, -1)) expect(p.length).toBeLessThanOrEqual(120);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long);
  });

  test('a single long sentence breaks on words, never a URL', () => {
    const url = 'https://penny.test/a/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const text = `here is the card ${url} and here is why it matters, because the quote is still open and the amount is below your cap for today`;
    const parts = splitReply(text, { maxChars: 60 });
    expect(parts.join(' ')).toContain(url);
    expect(parts.join(' ').split(url)).toHaveLength(2);
  });

  test('more parts than allowed are folded into the last text', () => {
    const text = `${'one. '.repeat(30)}end.`;
    const parts = splitReply(text, { maxChars: 40, maxParts: 3 });
    expect(parts).toHaveLength(3);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' ').trim());
  });

  test('empty text has nothing to send', () => {
    expect(shapeReply('   ')).toEqual([]);
    expect(shapeReply('Let me know if you need anything else.')).toEqual([]);
  });
});
