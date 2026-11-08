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
import { draftEmail, setReminder } from '../cards/everyday.ts';
import { billQuery, parseBillEmails } from '../connectors/composio.ts';
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
      'Find bills, invoices and payment notices in connected Gmail (read-only). If it says not connected, call connect_app for gmail and share the link.',
    risk: 'read',
    input: empty,
    execute: async (ctx) => {
      if (!ctx.connectors) return { ok: false, error: 'email not connected yet' };
      try {
        const raw = await ctx.connectors.executeRead(
          ctx.userId,
          ctx.bot.slug,
          'GMAIL_FETCH_EMAILS',
          {
            query: billQuery(),
            max_results: 10,
            verbose: false,
          },
        );
        const bills = parseBillEmails(raw);
        return { ok: true, count: bills.length, bills };
      } catch (e) {
        return { ok: false, error: (e as Error).name, hint: 'try connect_app gmail' };
      }
    },
  });
  add({
    id: 'connect_app',
    description:
      'Check whether an outside app (gmail, github) is connected for this user. If not, returns a connect link to share with the user verbatim. After they authorize, retry the original task.',
    risk: 'read',
    input: z.object({ toolkit: z.enum(['gmail', 'github']) }).strict(),
    execute: async (ctx, i) => {
      if (!ctx.connectors) return { ok: false, error: 'connectors not configured' };
      const r = await ctx.connectors.connect(ctx.userId, i.toolkit);
      if (r.status === 'connected') return { ok: true, connected: true, toolkit: i.toolkit };
      if (r.status === 'link')
        return {
          ok: false,
          connected: false,
          toolkit: i.toolkit,
          connectUrl: r.redirectUrl,
          tellUser: `tap this to connect your ${i.toolkit}: ${r.redirectUrl} - then say done and I will retry.`,
        };
      return { ok: false, connected: false, error: r.reason };
    },
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
      "Set a reminder. dueAt is an ISO-8601 date-time with the user's UTC offset (e.g. 2026-11-09T07:00:00+01:00). Sends a card with Undo.",
    risk: 'read', // stays inside Penny; the reminder is a text from Penny later
    input: z
      .object({ text: z.string().min(1).max(200), dueAt: z.iso.datetime({ offset: true }) })
      .strict(),
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
    description: 'Propose paying a bill in USDC.',
    risk: 'money',
    input: PayBillPlan,
    execute: propose,
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
