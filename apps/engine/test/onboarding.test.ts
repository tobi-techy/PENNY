import { beforeEach, describe, expect, test } from 'bun:test';
import { FakeConnector } from '../src/connectors/composio.ts';
import {
  bills0Text,
  ENROLLED_TEXT,
  FIRST_STEPS_TEXT,
  isGreeting,
  SETUP_LEAD_TEXT,
  WELCOME_TEXT,
} from '../src/onboarding.ts';
import type { SpaceRef } from '../src/ports/messaging.ts';
import { deviceKeys, makeEngine, scriptedModel, type TestEngine } from './helpers.ts';

class InboxConnector extends FakeConnector {
  inbox: Record<string, unknown>[] = [];
  connectedNow = false;
  override async isConnected(): Promise<boolean> {
    return this.connectedNow;
  }
  override async executeRead(): Promise<unknown> {
    return { data: { messages: this.inbox } };
  }
}

const HANDLE = '+15550100';
const space: SpaceRef = { spaceId: `any;-;${HANDLE}`, userHandle: HANDLE, phone: '+1PENNY' };

describe('greetings', () => {
  test.each(['hi', 'Hey!', 'hello penny', 'good morning', 'yo 👋', 'gm'])('%s is a greeting', (x) =>
    expect(isGreeting(x)).toBe(true),
  );
  test.each(['hi, any bills this week?', 'remind me at 6', 'hey can you pay dstv'])(
    '%s is not',
    (x) => expect(isGreeting(x)).toBe(false),
  );
});

describe('onboarding', () => {
  let t: TestEngine;
  let gmail: InboxConnector;
  let userId: string;
  let conversationId: string;
  const texts = () => t.messaging.texts.map((x) => x.text);

  beforeEach(async () => {
    gmail = new InboxConnector();
    t = await makeEngine({ connectors: gmail });
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    userId = (await t.engine.repos.users.findOrCreateByHandle(HANDLE)).id;
    conversationId = await t.engine.repos.users.conversationFor(
      userId,
      space.spaceId,
      'imessage',
      space.phone,
    );
  });

  test('a bare hi gets the welcome and a first step, and the crew is not run', async () => {
    const go = await t.engine.services.onboarding.welcome(space, conversationId, 'hi');
    expect(go).toBe(false);
    expect(texts()).toEqual([WELCOME_TEXT, FIRST_STEPS_TEXT]);
  });

  test('a real first question gets the welcome, then the crew answers it', async () => {
    const go = await t.engine.services.onboarding.welcome(space, conversationId, 'any bills?');
    expect(go).toBe(true);
    expect(texts()).toEqual([WELCOME_TEXT]);
  });

  test('needing approval texts the setup link once, then setup texts back', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'send' } }]),
      scriptedModel([
        {
          tool: 'propose_send',
          input: { kind: 'send', asset: 'USDC', amount: '5', to: 'ada.near' },
        },
        { text: 'tap the setup link i just sent, then ask again.' },
      ]),
    );
    await t.engine.services.crew.handle(userId, space, 'send ada $5', {
      conversationId,
      enrolled: false,
    });
    const link = texts().find((x) => x.includes('/setup#code='));
    expect(texts()).toContain(SETUP_LEAD_TEXT);
    expect(link).toMatch(/^https:\/\/penny\.test\/setup#code=[A-Z2-9]{8}$/);

    // a second refused action within minutes does not resend
    const n = texts().length;
    expect(await t.engine.services.onboarding.sendSetupLink(userId, space)).toEqual({
      sent: false,
      reason: 'link already sent a moment ago',
    });
    expect(texts().length).toBe(n);

    // the user taps it: the browser enrolls, Penny confirms in the thread
    const code = link?.split('#code=')[1] ?? '';
    await t.engine.services.enroll.enroll({
      enrollCode: code,
      publicKeyEd25519: deviceKeys().publicKeyB64Url,
    });
    expect(t.messaging.texts.at(-1)).toEqual({ space, text: ENROLLED_TEXT });

    // and once set up, no more links
    expect(
      (await t.engine.services.onboarding.sendSetupLink(userId, space, { force: true })).sent,
    ).toBe(false);
  });

  test('connect gmail: link with a callback, then Penny notices, says so and checks bills', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'connect' } }]),
      scriptedModel([{ tool: 'connect_app', input: { toolkit: 'gmail' } }, { text: 'link sent' }]),
    );
    await t.engine.services.crew.handle(userId, space, 'connect my gmail', { conversationId });
    expect(gmail.callbackUrls).toEqual(['https://penny.test/connected?app=gmail']);

    // not connected yet: nothing said
    expect(await t.engine.services.onboarding.checkConnections()).toBe(0);
    gmail.connectedNow = true;
    gmail.inbox = [
      {
        messageId: 'd1',
        subject: 'DStv bill: ₦18,400 due 14 Nov',
        sender: 'DStv <noreply@dstv.com>',
        messageTimestamp: '2026-11-08T09:00:00Z',
        snippet: '',
      },
    ];
    expect(await t.engine.services.onboarding.checkConnections()).toBe(1);
    expect(texts().slice(-2)).toEqual([
      "gmail's connected ✓ give me a sec, checking for bills…",
      "found 1 open bill:\n• DStv: ₦18,400, due sat 14 nov\ni'll remind you the day before each one's due. paid one already? just tell me.",
    ]);
    // announced once; the bill is not texted again by the background scan
    expect(await t.engine.services.onboarding.checkConnections()).toBe(0);
    await t.engine.services.bills.scanAll();
    expect(texts().filter((x) => x.includes('DStv')).length).toBe(1);
  });

  test('connect watches expire quietly after 30 minutes', async () => {
    await t.engine.services.onboarding.watchConnect(userId, 'gmail');
    t.clock.now = new Date('2026-11-08T12:31:00Z');
    gmail.connectedNow = true;
    expect(await t.engine.services.onboarding.checkConnections()).toBe(0);
    expect(texts()).toEqual([]);
  });

  test('empty inbox reads as all clear', () => {
    expect(bills0Text([])).toStartWith('all clear');
  });

  test('/connected page tells them to go back to Messages', async () => {
    const res = await t.engine.app.request('/connected?app=gmail');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Gmail connected ✓');
    const odd = await (await t.engine.app.request('/connected?app=<script>')).text();
    expect(odd).toContain('Your app connected ✓');
    expect(odd).not.toContain('<script>');
  });
});
