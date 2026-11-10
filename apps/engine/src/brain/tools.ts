import {
  addDecimal,
  CreateBotPlan,
  compareDecimal,
  Decimal,
  ErrandPlan,
  InvestPlan,
  type MoneyPlan,
  PayBillPlan,
  SendPlan,
  SplitPlan,
  WritePlan,
} from '@penny/shared';
import { z } from 'zod';
import { normalizeOffsetDateTime } from '../bills/time.ts';
import { draftEmail, setReminder } from '../cards/everyday.ts';
import { INVEST_ASSETS } from '../market/invest.ts';
import type { MarketPort, ToolContext, ToolDef } from './registry.ts';
import { ToolRegistry } from './registry.ts';

/**
 * Every tool is a deterministic function. Money tools only accept typed plans
 * and go Guard -> approval card. The model never builds transactions.
 */

async function propose(ctx: ToolContext, plan: MoneyPlan) {
  // NEAR sends are sized in USD by Guard, so they need a live NEAR price.
  let nearUsdPriceMicros: bigint | undefined;
  if (plan.kind === 'send' && plan.asset === 'NEAR' && ctx.market.nearUsdPriceMicros) {
    try {
      nearUsdPriceMicros = await ctx.market.nearUsdPriceMicros();
    } catch {
      return { decision: 'needs_more_info', reasons: ["I can't get a NEAR price right now."] };
    }
  }
  const r = await ctx.approvals.createMoneyApproval({
    userId: ctx.userId,
    bot: ctx.bot,
    plan,
    space: ctx.space,
    ...(nearUsdPriceMicros !== undefined ? { nearUsdPriceMicros } : {}),
  });
  // never hand the card token back to the model
  if (r.decision === 'allow_with_approval') {
    return { decision: r.decision, approvalId: r.approvalId, reasons: r.reasons, cardSent: true };
  }
  return r;
}

const empty = z.object({}).strict();
const InvestInput = z.object({ portfolioId: z.enum(INVEST_ASSETS), amountUsd: Decimal }).strict();
/** Accepts both `2026-11-14T18:00:00+01:00` and minute precision `2026-11-14T18:00+01:00`. */
const ReminderAt = z
  .string()
  .refine((s) => normalizeOffsetDateTime(s) !== null, {
    message: 'Use a date-time like 2026-11-14T18:00+01:00',
  })
  .transform((s) => normalizeOffsetDateTime(s) ?? s);

export function builtinTools(): ToolDef<never>[] {
  const defs: ToolDef<never>[] = [];
  const add = <I>(d: ToolDef<I>) => defs.push(d as unknown as ToolDef<never>);

  // ---- read ----
  add({
    id: 'get_balances',
    description: "Get the user's balances on their Penny account.",
    risk: 'read',
    input: empty,
    execute: async (ctx) =>
      ctx.accountId ? ctx.market.getBalances(ctx.accountId) : { ok: false, error: 'not set up' },
  });
  add({
    id: 'get_portfolios',
    description: 'List what Invest can buy (ETH, SOL, NEAR) with live USD prices.',
    risk: 'read',
    input: empty,
    execute: async (ctx) => {
      try {
        return await ctx.market.getPortfolios();
      } catch {
        return { ok: false, error: "I can't get prices right now." };
      }
    },
  });
  add({
    id: 'quote_invest',
    description:
      "Preview buying ETH, SOL or NEAR with the user's dollars: about how much they get, the least they get, fee, price, how long the price holds. Read-only. Then call propose_invest. Talk to the user in plain words, no crypto jargon.",
    risk: 'read',
    input: InvestInput,
    execute: async (ctx, i) =>
      ctx.approvals.previewInvest(ctx.userId, i.portfolioId, i.amountUsd, ctx.bot),
  });
  add({
    id: 'check_guard',
    description: 'Ask Guard whether a money plan would pass, without creating a card.',
    risk: 'read',
    input: z.union([InvestPlan, SendPlan, PayBillPlan, ErrandPlan]),
    execute: async (ctx, plan) => {
      const g = await ctx.approvals.checkGuard(ctx.userId, plan, ctx.bot);
      return { decision: g.decision, reasons: g.reasons };
    },
  });
  add({
    id: 'propose_split',
    description: 'Work out a bill split. No money moves.',
    risk: 'read',
    input: SplitPlan,
    execute: async (_ctx, plan) => {
      const sum = plan.participants.reduce((a, p) => addDecimal(a, p.share), '0');
      return { ok: compareDecimal(sum, plan.total) === 0, sum, plan };
    },
  });
  add({
    id: 'find_bills',
    description:
      "Check the user's connected Gmail for bills (read-only), save new ones, and return every open bill with payee, amount, due date and billId. New bills due later get an automatic reminder the day before. If it says not connected, call connect_app for gmail and share the link.",
    risk: 'read',
    input: empty,
    execute: async (ctx) => {
      if (!ctx.bills || !ctx.connectors) return { ok: false, error: 'email not connected yet' };
      const r = await ctx.bills.scan(ctx.userId, { interactive: true });
      if (!r.ok) return { ok: false, error: r.error, hint: 'try connect_app gmail' };
      const open = await ctx.bills.open(ctx.userId);
      const fresh = new Set(r.newBills.map((b) => b.id));
      return {
        ok: true,
        newCount: r.newBills.length,
        bills: open.map((b) => ({ ...b, isNew: fresh.has(b.billId) })),
      };
    },
  });
  add({
    id: 'list_bills',
    description:
      'List open bills Penny already knows about (no inbox read). Soonest due first. Use find_bills to check the inbox for new ones.',
    risk: 'read',
    input: empty,
    execute: async (ctx) =>
      ctx.bills ? { ok: true, bills: await ctx.bills.open(ctx.userId) } : { ok: false },
  });
  add({
    id: 'close_bill',
    description:
      "Mark a bill as paid (the user says they paid it elsewhere) or dismissed (not a real bill / not theirs). Cancels its reminder and any open payment card for it. Only when the user says so. This only updates Penny's own list; nothing outside Penny changes, so no approval is needed.",
    // risk stays `read`: Penny's own bookkeeping, no outside effect. AGENT.md's
    // write rule covers acting in the user's name outside Penny (posting, sending,
    // spending); editing this user's bill list is not such an action.
    risk: 'read',
    input: z
      .object({ billId: z.string().min(1).max(64), status: z.enum(['paid', 'dismissed']) })
      .strict(),
    execute: async (ctx, i) =>
      ctx.bills ? ctx.bills.close(ctx.userId, i.billId, i.status) : { ok: false },
  });
  add({
    id: 'list_reminders',
    description: "List the user's upcoming reminders (theirs and bill due-date ones).",
    risk: 'read',
    input: empty,
    execute: async (ctx) =>
      ctx.bills ? { ok: true, reminders: await ctx.bills.reminders(ctx.userId) } : { ok: false },
  });
  add({
    id: 'cancel_reminder',
    description:
      "Cancel an upcoming reminder by reminderId (from list_reminders). This only updates Penny's own reminder list; nothing outside Penny changes, so no approval is needed.",
    // risk stays `read`: Penny's own bookkeeping, no outside effect (AGENT.md's
    // write rule is about acting in the user's name outside Penny).
    risk: 'read',
    input: z.object({ reminderId: z.string().min(1).max(64) }).strict(),
    execute: async (ctx, i) =>
      ctx.bills ? ctx.bills.cancelReminder(ctx.userId, i.reminderId) : { ok: false },
  });
  add({
    id: 'connect_app',
    description:
      'Connect an outside app (gmail, github) for this user. If already connected, says so. Otherwise returns a link: share tellUser verbatim. Penny watches for the connection and texts the user herself when it is live (for gmail she also checks for bills), so do not ask them to say done.',
    risk: 'read',
    input: z.object({ toolkit: z.enum(['gmail', 'github']) }).strict(),
    execute: async (ctx, i) => {
      if (!ctx.connectors) return { ok: false, error: 'connectors not configured' };
      const r = await ctx.connectors.connect(
        ctx.userId,
        i.toolkit,
        ctx.onboarding ? { callbackUrl: ctx.onboarding.connectedUrl(i.toolkit) } : {},
      );
      if (r.status === 'connected') return { ok: true, connected: true, toolkit: i.toolkit };
      if (r.status === 'link') {
        await ctx.onboarding?.watchConnect(ctx.userId, i.toolkit);
        const what =
          i.toolkit === 'gmail'
            ? "i only read, and nothing gets sent from it without your ok. i'll text you the moment it's connected."
            : "i'll text you the moment it's connected.";
        return {
          ok: false,
          connected: false,
          toolkit: i.toolkit,
          connectUrl: r.redirectUrl,
          tellUser: `tap to connect your ${i.toolkit}: ${r.redirectUrl}\n${what}`,
        };
      }
      return { ok: false, connected: false, error: r.reason };
    },
  });
  add({
    id: 'send_setup_link',
    description:
      'Text the user a fresh link to turn on approvals (no app to install). Penny already sends it automatically when an action needs approval; use this when they ask for the link again or say it expired.',
    risk: 'read',
    input: empty,
    execute: async (ctx) =>
      ctx.onboarding
        ? ctx.onboarding.sendSetupLink(ctx.userId, ctx.space, { force: true })
        : { sent: false },
  });
  add({
    id: 'propose_write',
    description:
      'Propose a write in an outside app (send email, post comment, etc.). Creates a Face ID approval card; the write runs only if the user approves. Never use for money.',
    risk: 'write',
    input: WritePlan.omit({ kind: true }),
    execute: async (ctx, i) => {
      const r = await ctx.approvals.createWriteApproval({
        userId: ctx.userId,
        bot: ctx.bot,
        plan: { kind: 'write', ...i },
        space: ctx.space,
      });
      if (r.decision === 'allow_with_approval') {
        return {
          decision: r.decision,
          approvalId: r.approvalId,
          reasons: r.reasons,
          cardSent: true,
        };
      }
      return r;
    },
  });
  add({
    id: 'remember',
    description:
      'Save a short fact the user told you, for later. Never store secrets or card numbers.',
    risk: 'read', // internal to the user's own memory, no outside effect
    input: z
      .object({ kind: z.enum(['preference', 'fact', 'goal']), text: z.string().min(1).max(500) })
      .strict(),
    execute: async (ctx, i) => ({ id: await ctx.memory.remember(ctx.userId, i.kind, i.text) }),
  });
  add({
    id: 'recall',
    description: 'Look up things the user told you before.',
    risk: 'read',
    input: z.object({ query: z.string().min(1).max(200) }).strict(),
    execute: async (ctx, i) => ctx.memory.recall(ctx.userId, i.query, 5),
  });
  add({
    id: 'set_mood',
    description: 'Show a playful wink. Mood never changes money rules.',
    risk: 'read',
    input: z.object({ mood: z.enum(['wink']) }).strict(),
    execute: async (ctx) => ({ mood: await ctx.mood.on(ctx.userId, 'playful', ctx.bot.slug) }),
  });

  // ---- everyday info cards (no Face ID: nothing leaves Penny) ----
  add({
    id: 'set_reminder',
    description:
      "Set a reminder. dueAt is an ISO-8601 date-time with the user's UTC offset, e.g. 2026-11-09T07:00+01:00 (seconds optional). Sends a card with Undo. Nothing goes outside Penny; Penny texts the user when it is due.",
    // risk stays `read`: the reminder lives inside Penny and the later text is
    // Penny talking to the user, not an action in the user's name (AGENT.md).
    risk: 'read',
    input: z.object({ text: z.string().min(1).max(200), dueAt: ReminderAt }).strict(),
    execute: async (ctx, i) => {
      if (!ctx.everyday) return { ok: false, error: 'reminders are not set up' };
      const r = await setReminder(ctx.everyday, {
        userId: ctx.userId,
        space: ctx.space,
        agent: ctx.bot.builtIn ? 'penny' : ctx.bot.slug,
        text: i.text,
        dueAt: i.dueAt,
      });
      return r.ok ? { ok: true, cardSent: true, title: r.card.title } : r;
    },
  });
  add({
    id: 'draft_email',
    description:
      'Draft an email for the user. Sends a draft card with Send and Edit. Nothing is sent until the user taps Send and approves with Face ID. Never call propose_write for the same email.',
    risk: 'read', // a draft only; sending is send_email behind Face ID
    input: z
      .object({
        toName: z.string().min(1).max(60),
        toEmail: z.email().max(200),
        subject: z.string().max(200),
        body: z.string().max(5000),
      })
      .strict(),
    execute: async (ctx, i) => {
      if (!ctx.everyday) return { ok: false, error: 'drafts are not set up' };
      const r = await draftEmail(ctx.everyday, {
        userId: ctx.userId,
        space: ctx.space,
        agent: ctx.bot.builtIn ? (ctx.bot.slug === 'penny' ? 'mail' : ctx.bot.slug) : ctx.bot.slug,
        botId: ctx.bot.id,
        ...i,
      });
      return { ok: true, cardSent: true, title: r.card.title };
    },
  });

  // ---- money (Guard + Face ID card) ----
  add({
    id: 'propose_send',
    description:
      'Propose sending USDC or NEAR to a NEAR account. Creates a Face ID card if Guard allows.',
    risk: 'money',
    input: SendPlan,
    execute: propose,
  });
  add({
    id: 'propose_invest',
    description:
      'Propose investing USDC into ETH, SOL or NEAR. Guard checks first, then Penny fetches a firm quote and sends a Face ID card.',
    risk: 'money',
    input: InvestInput,
    execute: async (ctx, i) => {
      const r = await ctx.approvals.createInvestApproval({
        userId: ctx.userId,
        bot: ctx.bot,
        asset: i.portfolioId,
        amountUsd: i.amountUsd,
        space: ctx.space,
      });
      if (r.decision === 'allow_with_approval') {
        return {
          decision: r.decision,
          approvalId: r.approvalId,
          reasons: r.reasons,
          cardSent: true,
        };
      }
      return r;
    },
  });
  add({
    id: 'propose_pay_bill',
    description:
      "Propose paying one of the user's saved bills in USDC, by billId (from find_bills or list_bills). Penny fills in the biller's payout account and the exact amount from the bill; you never supply a payee. Only works when the bill shows payableInApp; otherwise tell the user notPayableBecause and offer a reminder.",
    risk: 'money',
    input: z.object({ billId: z.string().min(1).max(64) }).strict(),
    execute: async (ctx, i) => {
      if (!ctx.bills) return { decision: 'needs_more_info', reasons: ['bills are not set up'] };
      // Check the dollars are there before showing a card that can only fail.
      const wallet: { usdc?: string } = {};
      if (ctx.accountId) {
        try {
          const usdc = (await ctx.market.getBalances(ctx.accountId)).find(
            (b) => b.asset === 'USDC',
          );
          if (usdc) wallet.usdc = usdc.amount;
        } catch {
          /* balance unknown: Guard and the chain still stop a short payment */
        }
      }
      const p = await ctx.bills.paymentPlan(ctx.userId, i.billId, wallet);
      if (!p.ok) return { decision: 'needs_more_info', reasons: [p.reason] };
      const r = await ctx.approvals.createMoneyApproval({
        userId: ctx.userId,
        bot: ctx.bot,
        plan: p.plan,
        space: ctx.space,
        facts: p.facts,
      });
      if (r.decision === 'allow_with_approval') {
        return {
          decision: r.decision,
          approvalId: r.approvalId,
          reasons: r.reasons,
          cardSent: true,
        };
      }
      return r;
    },
  });
  add({
    id: 'propose_errand',
    description: 'Propose paying for an errand bid in USDC.',
    risk: 'money',
    input: ErrandPlan,
    execute: propose,
  });

  // ---- core-crew plumbing ----
  add({
    id: 'draft_bot',
    description:
      'Draft a new bot from what the user described: slug, name, SOUL.md and tool ids. Pick the fewest tools. Never add money tools unless the user named a spending cap.',
    risk: 'read',
    builtInOnly: true,
    input: CreateBotPlan,
    execute: async (ctx, plan) => ctx.botOps.draft(ctx.userId, plan, ctx.space),
  });
  add({
    id: 'confirm_bot',
    description: 'Turn on a read-only bot the user just said yes to.',
    risk: 'read',
    builtInOnly: true,
    input: z.object({ slug: z.string().min(2).max(32) }).strict(),
    execute: async (ctx, i) => ctx.botOps.confirm(ctx.userId, i.slug),
  });

  // ---- connector tools for custom bots (stubs until connectors exist) ----
  const notConnected = async () => ({ ok: false, error: 'connector not set up yet' });
  add({
    id: 'read_github',
    description: 'Read repos, issues and PRs on GitHub.',
    risk: 'read',
    input: z.object({ query: z.string().max(200) }).strict(),
    execute: notConnected,
  });
  add({
    id: 'read_x',
    description: 'Read your X timeline and mentions.',
    risk: 'read',
    input: z.object({ query: z.string().max(200) }).strict(),
    execute: notConnected,
  });
  add({
    id: 'post_x',
    description: 'Post on X as the user.',
    risk: 'write',
    input: z.object({ text: z.string().min(1).max(280) }).strict(),
    execute: notConnected,
  });
  add({
    id: 'github_comment',
    description: 'Comment on a GitHub issue or PR as the user.',
    risk: 'write',
    input: z
      .object({
        repo: z.string().max(140),
        number: z.number().int().positive(),
        body: z.string().max(4000),
      })
      .strict(),
    execute: notConnected,
  });

  return defs;
}

export function createRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const d of builtinTools()) r.register(d);
  return r;
}

/** Fixed data for DRY_RUN dev and tests. */
export class FakeMarket implements MarketPort {
  constructor(readonly now: () => Date = () => new Date()) {}
  async nearUsdPriceMicros() {
    return 4_000_000n;
  }
  async getBalances() {
    return [
      { asset: 'USDC', amount: '120.5' },
      { asset: 'NEAR', amount: '3.2' },
    ];
  }
  async getPortfolios() {
    return [
      { id: 'ETH', name: 'ETH', blurb: 'Ether', priceUsd: '2000' },
      { id: 'SOL', name: 'SOL', blurb: 'Solana', priceUsd: '100' },
      { id: 'NEAR', name: 'NEAR', blurb: 'NEAR', priceUsd: '4' },
    ];
  }
}
