import { afterEach, describe, expect, test } from 'bun:test';
import { parseLearnedFacts } from '../src/brain/crew.ts';
import { hasEmoji, stripEmoji, toPlainText } from '../src/lib/plain-text.ts';
import { enrolledUser, makeEngine, scriptedModel, type TestEngine } from './helpers.ts';

describe('plain tone', () => {
  test('decorative emoji are removed, the words stay', () => {
    expect(stripEmoji(toPlainText('on it 🎉 **done** 📬'))).toBe('on it done');
    expect(hasEmoji('hello 🎉')).toBe(true);
    expect(hasEmoji('hello')).toBe(false);
  });
});

describe('parseLearnedFacts', () => {
  test('keeps only well-formed kind | text lines', () => {
    expect(
      parseLearnedFacts(
        'preference | likes tea in the morning\nnonsense\nfact | lives in Lagos\nbogus | x',
      ),
    ).toEqual([
      { kind: 'preference', text: 'likes tea in the morning' },
      { kind: 'fact', text: 'lives in Lagos' },
    ]);
  });
});

describe('learning from a turn', () => {
  let t: TestEngine;
  afterEach(async () => {
    await t?.db.close();
  });

  test('stores durable facts once, and never stores a secret', async () => {
    t = await makeEngine({ extra: { autoLearn: true } });
    const u = await enrolledUser(t);
    t.setModels(
      scriptedModel([{ text: '' }]),
      scriptedModel([
        { text: 'preference | likes morning briefs\nfact | lives in Lagos' },
        { text: 'preference | likes morning briefs' },
        { text: 'fact | password is hunter2' },
      ]),
    );

    await t.engine.services.crew.learnFromTurn(
      u.userId,
      'i like morning briefs and i live in lagos',
    );
    let rows = await t.engine.services.memory.recent(u.userId);
    expect(rows.map((r) => r.text).sort()).toEqual(['likes morning briefs', 'lives in Lagos']);

    t.clock.now = new Date(t.clock.now.getTime() + 30_000);
    await t.engine.services.crew.learnFromTurn(u.userId, 'morning briefs again please');
    rows = await t.engine.services.memory.recent(u.userId);
    expect(rows.filter((r) => r.text === 'likes morning briefs')).toHaveLength(1);

    t.clock.now = new Date(t.clock.now.getTime() + 30_000);
    await t.engine.services.crew.learnFromTurn(u.userId, 'my password is hunter2, remember it');
    rows = await t.engine.services.memory.recent(u.userId);
    expect(rows.some((r) => r.text.toLowerCase().includes('hunter2'))).toBe(false);
  });
});
