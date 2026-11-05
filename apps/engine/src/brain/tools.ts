import {
  addDecimal,
  CreateBotPlan,
  compareDecimal,
  ErrandPlan,
  InvestPlan,
  type MoneyPlan,
  PayBillPlan,
  SendPlan,
  SplitPlan,
} from '@penny/shared';
import { z } from 'zod';
import type { MarketPort, ToolContext, ToolDef } from './registry.ts';
import { ToolRegistry } from './registry.ts';

/**
 * Every tool is a deterministic function. Money tools only accept typed plans
 * and go Guard -> approval card. The model never builds transactions.
 */

async function propose(ctx: ToolContext, plan: MoneyPlan) {
  const quote = plan.kind === 'invest' ? ctx.quotes.get(plan.quoteId) : undefined;
  const r = await ctx.approvals.createMoneyApproval({
    userId: ctx.userId,
    bot: ctx.bot,
    plan,
    space: ctx.space,
    ...(quote ? { quote } : {}),
  });
  // never hand the card token back to the model
  if (r.decision === 'allow_with_approval') {
    return { decision: r.decision, approvalId: r.approvalId, reasons: r.reasons, cardSent: true };
  }
  return r;
}

const empty = z.object({}).strict();

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
    description: 'List investable portfolios (Glider).',
    risk: 'read',
    input: empty,
    execute: async (ctx) => ctx.market.getPortfolios(),
  });
  add({
    id: 'quote_invest',
    description:
      'Get a short-lived quote to invest USDC into a portfolio. Needed before propose_invest.',
    risk: 'read',
    input: z.object({ portfolioId: z.string().min(1).max(128), amountUsd: z.string() }).strict(),
    execute: async (ctx, i) => {
      const q = await ctx.market.quoteInvest(i.portfolioId, i.amountUsd);
      ctx.quotes.set(q.quoteId, { id: q.quoteId, expiresAt: q.expiresAt });
      return { quoteId: q.quoteId, expiresAt: q.expiresAt.toISOString(), feeUsd: q.feeUsd };
    },
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
    description: 'Find upcoming bills in connected email (read-only). Not connected in v0.1.',
    risk: 'read',
    input: empty,
    execute: async () => ({ ok: false, error: 'email not connected yet' }),
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
    description: 'Propose investing USDC into a portfolio using a quoteId from quote_invest.',
    risk: 'money',
    input: InvestPlan,
    execute: propose,
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
  constructor(private readonly now: () => Date = () => new Date()) {}
  async getBalances() {
    return [
      { asset: 'USDC', amount: '120.5' },
      { asset: 'NEAR', amount: '3.2' },
    ];
  }
  async getPortfolios() {
    return [
      { id: 'eth-momentum', name: 'ETH Momentum', blurb: 'rides ETH trends, rebalances weekly' },
      { id: 'steady-stables', name: 'Steady Stables', blurb: 'yield on stablecoins' },
    ];
  }
  async quoteInvest(portfolioId: string, amountUsd: string) {
    return {
      quoteId: `q_${portfolioId}_${amountUsd}`,
      expiresAt: new Date(this.now().getTime() + 90_000),
      feeUsd: '0.12',
    };
  }
}
