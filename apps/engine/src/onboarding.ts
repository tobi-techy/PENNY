import { formatDay } from './bills/parse.ts';
import type { BillsService } from './bills/service.ts';
import type { ConnectorPort } from './connectors/composio.ts';
import type { EnrollService } from './devices/enroll.ts';
import type { Logger } from './lib/logger.ts';
import type { MessagingPort, SpaceRef } from './ports/messaging.ts';
import type { MessagesRepo } from './repo/bots.ts';
import type { ConnectWatchesRepo } from './repo/connect-watches.ts';
import type { UsersRepo } from './repo/users.ts';

/**
 * First contact and the "connect things" moments, all deterministic copy:
 * - the first text gets a short welcome, then Penny answers what they said
 *   (or, for a bare "hi", suggests a first thing to try). No setup link yet.
 * - the setup link goes out only when something needs approval, at most once
 *   per few minutes, and Penny texts again when setup is done.
 * - after a connect link, Penny watches for the connection and says so itself
 *   (then checks for bills), so nobody has to text "done".
 */

const SETUP_RESEND_MS = 3 * 60_000;
const WATCH_TTL_MS = 30 * 60_000;

const GREETING_RE =
  /^\s*(hi+|hey+|hello+|hiya|yo+|sup|wassup|what'?s up|howdy|good (morning|afternoon|evening)|gm|start|hey penny|hi penny|hello penny)[\s!.👋🙂😊]*$/iu;

export function isGreeting(text: string): boolean {
  return GREETING_RE.test(text);
}

export const WELCOME_TEXT =
  "hey, i'm penny. i help run the everyday stuff from right here: bills, reminders, your inbox, money.";

export const FIRST_STEPS_TEXT =
  'a good first step: say "connect my gmail" and i\'ll keep an eye out for bills and remind you before they\'re due. or try "remind me to call mum at 6".';

export const SETUP_LEAD_TEXT =
  'one quick thing before i can do that: tap this to turn on approvals. 10 seconds, nothing to install. you approve every payment or action yourself.';

export const ENROLLED_TEXT =
  "you're set. approvals are on. anything that spends money or acts for you comes here as a card first, and only goes ahead when you approve it. go ahead and ask me again.";

export type OnboardingDeps = {
  users: UsersRepo;
  messages: MessagesRepo;
  messaging: MessagingPort;
  enroll: EnrollService;
  watches: ConnectWatchesRepo;
  connectors?: ConnectorPort;
  bills?: BillsService;
  publicBaseUrl: string;
  log: Logger;
  now: () => Date;
};

export class OnboardingService {
  private readonly lastSetupLink = new Map<string, number>();

  constructor(private readonly d: OnboardingDeps) {}

  private base(): string {
    return this.d.publicBaseUrl.replace(/\/$/, '');
  }

  private async say(space: SpaceRef, conversationId: string | null, text: string, log?: string) {
    await this.d.messaging.sendText(space, text);
    if (conversationId)
      await this.d.messages.add({ conversationId, direction: 'outbound', text: log ?? text });
  }

  /**
   * First text from someone new. Returns true when the crew should still answer
   * their message (anything other than a bare greeting).
   */
  async welcome(space: SpaceRef, conversationId: string, firstText: string): Promise<boolean> {
    await this.say(space, conversationId, WELCOME_TEXT);
    if (isGreeting(firstText)) {
      await this.say(space, conversationId, FIRST_STEPS_TEXT);
      return false;
    }
    return true;
  }

  /**
   * Text the setup link (its own message, code in the fragment). Throttled so a
   * chain of refused actions sends one link, unless `force` (the user asked).
   */
  async sendSetupLink(
    userId: string,
    space: SpaceRef,
    opts: { force?: boolean } = {},
  ): Promise<{ sent: boolean; reason?: string }> {
    const now = this.d.now().getTime();
    const last = this.lastSetupLink.get(userId) ?? 0;
    if (!opts.force && now - last < SETUP_RESEND_MS)
      return { sent: false, reason: 'link already sent a moment ago' };
    if (await this.d.users.activeDevice(userId))
      return { sent: false, reason: 'approvals are already set up' };
    const user = await this.d.users.byId(userId);
    if (!user) return { sent: false, reason: 'unknown user' };
    const { code } = await this.d.enroll.issue(userId, user.handle);
    this.lastSetupLink.set(userId, now);
    const target = await this.d.users.primarySpace(userId);
    const conv = target?.conversationId ?? null;
    await this.say(space, conv, SETUP_LEAD_TEXT);
    await this.say(space, conv, `${this.base()}/setup#code=${code}`, 'setup link [code]');
    return { sent: true };
  }

  /** A device just enrolled from the setup page: tell them in the thread. */
  async onEnrolled(userId: string): Promise<void> {
    this.lastSetupLink.delete(userId);
    const target = await this.d.users.primarySpace(userId);
    if (!target) return;
    await this.say(target.space, target.conversationId, ENROLLED_TEXT);
  }

  /** Where the browser lands after authorizing an app. */
  connectedUrl(toolkit: string): string {
    return `${this.base()}/connected?app=${encodeURIComponent(toolkit)}`;
  }

  /** Penny just sent a connect link: watch for it to go live. */
  async watchConnect(
    userId: string,
    toolkit: string,
    opts: { link?: string; space?: SpaceRef } = {},
  ): Promise<void> {
    await this.d.watches.watch(userId, toolkit, new Date(this.d.now().getTime() + WATCH_TTL_MS));
    // Send the connect URL as its own card, not buried in a sentence.
    if (opts.link && opts.space) await this.d.messaging.sendLink(opts.space, opts.link);
  }

  /** Scheduler: announce new connections, then do the first useful thing. */
  async checkConnections(): Promise<number> {
    if (!this.d.connectors) return 0;
    const now = this.d.now();
    await this.d.watches.expire(now);
    let announced = 0;
    for (const w of await this.d.watches.waiting(now)) {
      try {
        if (!(await this.d.connectors.isConnected(w.userId, w.toolkit))) continue;
        if (!(await this.d.watches.markConnected(w.userId, w.toolkit))) continue;
        const target = await this.d.users.primarySpace(w.userId);
        if (!target) continue;
        announced += 1;
        if (w.toolkit === 'gmail') await this.afterGmail(w.userId, target);
        else
          await this.say(
            target.space,
            target.conversationId,
            `${w.toolkit}'s connected. what should i do with it?`,
          );
      } catch (e) {
        this.d.log.warn({ err: (e as Error).name, toolkit: w.toolkit }, 'connect check failed');
      }
    }
    return announced;
  }

  private async afterGmail(
    userId: string,
    target: { conversationId: string; space: SpaceRef },
  ): Promise<void> {
    const { space, conversationId } = target;
    await this.say(space, conversationId, "gmail's connected. give me a sec, checking for bills…");
    if (!this.d.bills) return;
    const r = await this.d.bills.scan(userId, { interactive: true });
    if (!r.ok) {
      await this.say(
        space,
        conversationId,
        'hmm, i couldn\'t read your inbox just now. i\'ll try again later, or ask me "any bills?" in a bit.',
      );
      return;
    }
    await this.say(space, conversationId, bills0Text(await this.d.bills.open(userId)));
  }
}

type OpenBill = Awaited<ReturnType<BillsService['open']>>[number];

/** The first-scan summary after Gmail connects. */
export function bills0Text(open: OpenBill[]): string {
  if (!open.length)
    return "all clear: no bills in your inbox from the last 2 months. i'll check every few hours and text you when one lands.";
  const shown = open
    .slice(0, 4)
    .map(
      (b) =>
        `• ${b.payee}: ${b.amount}${b.dueOn ? `${b.overdue ? ', was due' : ', due'} ${formatDay(b.dueOn)}` : ''}`,
    );
  const more = open.length > 4 ? `\n…and ${open.length - 4} more.` : '';
  const head = open.length === 1 ? 'found 1 open bill:' : `found ${open.length} open bills:`;
  return `${head}\n${shown.join('\n')}${more}\ni'll remind you the day before each one's due. paid one already? just tell me.`;
}
