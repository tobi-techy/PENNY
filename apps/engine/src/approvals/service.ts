import {
  type Approval,
  type ApprovalStatusResponse,
  type CreateBotPlan,
  compareDecimal,
  Decimal,
  formatUsd,
  fromMicros,
  type IntentPlan,
  type MoneyPlan,
  type NearAction,
  planAmount,
  planApprovalMessage,
  planHash,
  planRecipient,
  type WritePlan,
} from '@penny/shared';
import type { MoodService } from '../brain/mood.ts';
import { writeTargetProblem } from '../connectors/composio.ts';
import {
  evaluate,
  type GuardContext,
  type GuardPolicy,
  type GuardResult,
} from '../guard/policy.ts';
import { verifyEd25519 } from '../lib/crypto.ts';
import { newId } from '../lib/ids.ts';
import type { Logger } from '../lib/logger.ts';
import {
  type InvestPort,
  type InvestQuote,
  isInvestAsset,
  type SwapState,
} from '../market/invest.ts';
import type { ChainPort } from '../ports/chain.ts';
import type { ApprovalCard, CardHandle, MessagingPort, SpaceRef } from '../ports/messaging.ts';
import type { ApprovalRow, ApprovalsRepo } from '../repo/approvals.ts';
import type { BotRow, BotsRepo } from '../repo/bots.ts';
import type { GuardDecisionsRepo } from '../repo/infra.ts';
import { DAY_MS, type LedgerRepo } from '../repo/ledger.ts';
import type { UsersRepo } from '../repo/users.ts';
import { checkCardToken, issueCardToken } from './card-token.ts';
import { isTerminal, stepsFor } from './state.ts';
import { writeFacts } from './write-facts.ts';

export const QUOTE_TTL_CAP_MS = 120_000;
export const BOT_APPROVAL_TTL_MS = 10 * 60_000;
const TEN_MIN = 10 * 60_000;

export type Clock = () => Date;

export class ApprovalError extends Error {
  override name = 'ApprovalError';
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type CreateResult =
  | {
      decision: 'allow_with_approval';
      approvalId: string;
      cardToken: string;
      url: string;
      reasons: string[];
    }
  | { decision: 'block' | 'needs_more_info'; reasons: string[] };

export type ApprovalDeps = {
  approvals: ApprovalsRepo;
  ledger: LedgerRepo;
  users: UsersRepo;
  bots?: BotsRepo;
  guardDecisions: GuardDecisionsRepo;
  chain: ChainPort;
  messaging: MessagingPort;
  mood: MoodService;
  log: Logger;
  publicBaseUrl: string;
  now: Clock;
  /** Hard per-tx ceiling (mainnet launch cap) clamped over user policy. */
  mainnetMaxPerTxUsd?: string;
  /** Hard daily ceiling (mainnet launch cap) clamped over user policy. */
  mainnetMaxDailyUsd?: string;
  /** Env hard ceiling on NEAR the relayer fronts for one approval (yocto). Checked before the card. */
  relayerMaxDepositYocto?: bigint;
  /** Invest quotes and swap status (NEAR Intents 1Click). Without it, invest is off. */
  invest?: InvestPort;
  /** Executes an approved write in an outside app (connector layer). */
  executeWrite?: (
    userId: string,
    toolkit: string,
    toolSlug: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  /** called when a create_bot approval settles */
  onBotApproved?: (approvalId: string) => Promise<void>;
  onBotDeclined?: (approvalId: string) => Promise<void>;
};

export function toApprovalDto(r: ApprovalRow): Approval {
  return {
    id: r.id,
    userId: r.userId,
    kind: r.kind,
    plan: r.plan as IntentPlan,
    title: r.title,
    amountDisplay: r.amountDisplay,
    facts: r.facts,
    signerId: r.signerId,
    receiverId: r.receiverId,
    actions: r.actions as NearAction[],
    nonce: r.nonce,
    maxBlockHeight: r.maxBlockHeight,
    expiresAt: r.expiresAt.toISOString(),
    status: r.status,
    planHash: r.planHash,
  };
}

const SWAP_LINE: Record<SwapState, string> = {
  pending: 'pending · waiting for NEAR Intents to see the deposit',
  processing: 'processing · swapping now',
  success: 'success ✓',
  refunded: 'refunded · your USDC is back',
  failed: 'failed · nothing was swapped',
};

/** The 1Click deposit address an invest approval pays: the ft_transfer receiver. */
export function investDepositAddress(actions: NearAction[]): string | null {
  for (const a of actions) {
    if (a.type === 'FunctionCall' && a.methodName === 'ft_transfer') {
      const r = (a.args as { receiver_id?: unknown }).receiver_id;
      return typeof r === 'string' ? r : null;
    }
  }
  return null;
}

/** Card facts for an invest preview/approval (max 7, plus the daily limit). */
export function investFacts(q: InvestQuote, now: Date): { label: string; value: string }[] {
  const secs = Math.max(0, Math.round((q.expiresAt.getTime() - now.getTime()) / 1000));
  const fee = q.keyless
    ? `≈$${q.feeUsd} incl. 0.2% no-partner-key fee`
    : `≈$${q.feeUsd}${q.feeBps ? ` incl. ${q.feeBps / 100}% partner fee` : ''}`;
  return [
    { label: 'You pay', value: `${q.amountUsd} USDC` },
    { label: 'You get (est.)', value: q.amountOutDisplay },
    { label: 'Rate', value: q.rateDisplay },
    { label: 'Fee', value: fee.slice(0, 80) },
    { label: 'Min received', value: `${q.minOutDisplay} (${q.slippageBps / 100}% slippage)` },
    { label: 'Expires', value: `in ${secs}s` },
    { label: 'Goes to', value: 'your NEAR Intents balance' },
  ];
}

function titleFor(plan: IntentPlan): string {
  switch (plan.kind) {
    case 'invest':
      return `Invest · USDC → ${plan.portfolioId}`.slice(0, 80);
    case 'send':
      return `Send ${plan.asset} · ${plan.to}`.slice(0, 80);
    case 'pay_bill':
      return `Pay bill · ${plan.payee}`.slice(0, 80);
    case 'errand':
      return `Errand · ${plan.taskId}`.slice(0, 80);
    case 'split':
      return 'Split';
    case 'create_bot':
      return `New bot · ${plan.name}`.slice(0, 80);
    case 'write':
      return plan.title.slice(0, 80);
  }
}

export class ApprovalService {
  private cards = new Map<string, { handle: CardHandle; space: SpaceRef; card: ApprovalCard }>();

  constructor(private readonly d: ApprovalDeps) {}

  private cardUrl(id: string, token: string) {
    // token in the fragment so it never hits server/proxy logs on open
    return `${this.d.publicBaseUrl.replace(/\/$/, '')}/a/${id}#t=${token}`;
  }

  async guardContext(
    userId: string,
    bot: BotRow | null,
    extra: Partial<GuardContext> = {},
  ): Promise<GuardContext> {
    const now = this.d.now();
    const since = new Date(now.getTime() - DAY_MS);
    const ctx: GuardContext = {
      now,
      spentLast24hMicros: await this.d.ledger.spentSince(userId, since),
      knownRecipients: await this.d.ledger.knownRecipients(userId),
      approvalsLast10Min: await this.d.approvals.countCreatedSince(
        userId,
        new Date(now.getTime() - TEN_MIN),
      ),
      ...extra,
    };
    if (bot && !bot.builtIn) {
      ctx.bot = {
        botSlug: bot.slug,
        canMoveMoney: bot.permissions.canMoveMoney,
        ...(bot.permissions.perTxCap ? { perTxCap: bot.permissions.perTxCap } : {}),
        ...(bot.permissions.dailyCap ? { dailyCap: bot.permissions.dailyCap } : {}),
        spentLast24hMicros: await this.d.ledger.spentSince(userId, since, bot.id),
      };
    }
    return ctx;
  }

  async checkGuard(
    userId: string,
    plan: MoneyPlan,
    bot: BotRow | null,
    extra: Partial<GuardContext> = {},
  ): Promise<GuardResult> {
    const policy = await this.effectivePolicy(userId);
    return evaluate(plan, policy, await this.guardContext(userId, bot, extra));
  }

  /**
   * The user's Guard policy with the mainnet launch caps clamped over it: per-tx and
   * daily total each bounded by their env ceiling. Used before the card AND before relay.
   */
  async effectivePolicy(userId: string): Promise<GuardPolicy> {
    const policy = await this.d.users.policy(userId);
    const tx = this.d.mainnetMaxPerTxUsd;
    if (tx && compareDecimal(policy.perTxUsd, tx) > 0) policy.perTxUsd = tx;
    const day = this.d.mainnetMaxDailyUsd;
    if (day && compareDecimal(policy.dailyUsd, day) > 0) policy.dailyUsd = day;
    return policy;
  }

  /** Money tools land here: Guard, then approval + live card. */
  async createMoneyApproval(input: {
    userId: string;
    bot: BotRow | null;
    plan: MoneyPlan;
    space: SpaceRef;
    quote?: { id: string; expiresAt: Date };
    nearUsdPriceMicros?: bigint;
    /** Replace the default facts (the daily limit is always appended). */
    facts?: { label: string; value: string }[];
    subcaption?: string;
  }): Promise<CreateResult> {
    const { userId, plan, bot } = input;
    const user = await this.d.users.byId(userId);
    const device = user ? await this.d.users.activeDevice(userId) : null;
    if (!user?.accountId || !device) {
      return {
        decision: 'needs_more_info',
        reasons: ['Finish setting up Penny on your iPhone first.'],
      };
    }
    const extra: Partial<GuardContext> = {};
    if (input.quote) extra.quote = input.quote;
    if (input.nearUsdPriceMicros !== undefined) extra.nearUsdPriceMicros = input.nearUsdPriceMicros;
    const g = await this.checkGuard(userId, plan, bot, extra);
    if (g.decision !== 'allow_with_approval') {
      await this.d.guardDecisions.record({
        userId,
        approvalId: null,
        plan,
        decision: g.decision,
        reasons: g.reasons,
      });
      if (g.decision === 'block') await this.d.mood.on(userId, 'guard_blocked', 'guard');
      return { decision: g.decision, reasons: g.reasons };
    }

    const built = await this.d.chain.buildActions(plan, user.accountId);
    // Limits before the card: the relayer fronts attached deposits, so an approval may
    // never carry more than the env hard ceiling (the relay re-checks the same bound).
    if (this.d.relayerMaxDepositYocto !== undefined) {
      const deposit = built.actions.reduce((sum, a) => sum + BigInt(a.deposit), 0n);
      if (deposit > this.d.relayerMaxDepositYocto) {
        const reasons = ["That's more NEAR than I can send in one go right now."];
        await this.d.guardDecisions.record({
          userId,
          approvalId: null,
          plan,
          decision: 'block',
          reasons,
        });
        await this.d.mood.on(userId, 'guard_blocked', 'guard');
        return { decision: 'block', reasons };
      }
    }
    const signing = await this.d.chain.prepareSigning(user.accountId, device.publicKey);
    const now = this.d.now();
    const cap = now.getTime() + QUOTE_TTL_CAP_MS;
    const expiresAt = new Date(Math.min(cap, input.quote ? input.quote.expiresAt.getTime() : cap));
    const { token, hash } = issueCardToken();
    const id = newId('apr');
    const policy = await this.effectivePolicy(userId);
    const amountDisplay = formatUsd(g.amountMicrosUsd);
    const facts = input.facts
      ? [...input.facts.slice(0, 7), { label: 'Daily limit', value: `$${policy.dailyUsd}` }]
      : [
          { label: 'Amount', value: `${planAmount(plan).amount} ${planAmount(plan).asset}` },
          { label: 'Daily limit', value: `$${policy.dailyUsd}` },
        ];
    const recipient = planRecipient(plan);
    if (recipient && !input.facts) facts.unshift({ label: 'To', value: recipient.slice(0, 80) });

    await this.d.approvals.create({
      id,
      userId,
      botId: bot?.id ?? null,
      kind: plan.kind,
      plan,
      title: titleFor(plan),
      amountDisplay,
      amountMicros: g.amountMicrosUsd,
      facts,
      signerId: user.accountId,
      receiverId: built.receiverId,
      actions: built.actions,
      nonce: signing.nonce,
      maxBlockHeight: signing.maxBlockHeight,
      expiresAt,
      status: 'pending',
      planHash: planHash(plan, built.actions),
      cardTokenHash: hash,
    });
    await this.d.ledger.reserve({
      userId,
      approvalId: id,
      botId: bot && !bot.builtIn ? bot.id : null,
      asset: planAmount(plan).asset,
      amountMicrosUsd: g.amountMicrosUsd,
      recipient,
    });
    await this.d.guardDecisions.record({
      userId,
      approvalId: id,
      plan,
      decision: g.decision,
      reasons: g.reasons,
    });
    await this.d.mood.on(userId, 'approval_created');
    const url = this.cardUrl(id, token);
    await this.sendCard(id, input.space, {
      approvalId: id,
      url,
      caption: titleFor(plan),
      subcaption: input.subcaption ?? `${amountDisplay} · tap to approve`,
      live: true,
    });
    return {
      decision: 'allow_with_approval',
      approvalId: id,
      cardToken: token,
      url,
      reasons: g.reasons,
    };
  }

  // ---------- invest (NEAR Intents 1Click) ----------

  /** Read-only preview: dry quote + a Guard read. Nothing is signed, no card. */
  async previewInvest(userId: string, asset: string, amountUsd: string) {
    if (!this.d.invest) return { ok: false, error: 'invest is not switched on' };
    if (!isInvestAsset(asset)) return { ok: false, error: 'I can buy ETH, SOL or NEAR' };
    if (!Decimal.safeParse(amountUsd).success) return { ok: false, error: 'bad amount' };
    const user = await this.d.users.byId(userId);
    if (!user?.accountId) return { ok: false, error: 'finish setting up Penny first' };
    const plan: MoneyPlan = {
      kind: 'invest',
      fromAsset: 'USDC',
      amountUsd,
      portfolioId: asset,
      quoteId: 'preview',
    };
    const now = this.d.now();
    const g = await this.checkGuard(userId, plan, null, {
      quote: { id: 'preview', expiresAt: new Date(now.getTime() + 60_000) },
    });
    let q: InvestQuote;
    try {
      q = await this.d.invest.preview(asset, amountUsd, user.accountId);
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'invest preview failed');
      return { ok: false, error: "couldn't get a live price from NEAR Intents just now" };
    }
    return {
      ok: true,
      facts: investFacts(q, now),
      keylessFee: q.keyless,
      guard: { decision: g.decision, reasons: g.reasons },
    };
  }

  /**
   * Guard (limits) first, then a firm 1Click quote, then the Face ID card.
   * Guard runs again inside createMoneyApproval with the real quote, and again before relay.
   */
  async createInvestApproval(input: {
    userId: string;
    bot: BotRow | null;
    asset: string;
    amountUsd: string;
    space: SpaceRef;
    note?: string;
  }): Promise<CreateResult> {
    const { userId, bot, asset, amountUsd } = input;
    if (!this.d.invest)
      return { decision: 'needs_more_info', reasons: ["Invest isn't switched on yet."] };
    if (!isInvestAsset(asset))
      return { decision: 'block', reasons: ['I can only buy ETH, SOL or NEAR for now.'] };
    if (!Decimal.safeParse(amountUsd).success)
      return { decision: 'needs_more_info', reasons: ['How much, in dollars?'] };
    const user = await this.d.users.byId(userId);
    const device = user ? await this.d.users.activeDevice(userId) : null;
    if (!user?.accountId || !device) {
      return {
        decision: 'needs_more_info',
        reasons: ['Finish setting up Penny on your iPhone first.'],
      };
    }
    const provisional: MoneyPlan = {
      kind: 'invest',
      fromAsset: 'USDC',
      amountUsd,
      portfolioId: asset,
      quoteId: 'pending',
    };
    const now = this.d.now();
    const g0 = await this.checkGuard(userId, provisional, bot, {
      quote: { id: 'pending', expiresAt: new Date(now.getTime() + 60_000) },
    });
    if (g0.decision !== 'allow_with_approval') {
      await this.d.guardDecisions.record({
        userId,
        approvalId: null,
        plan: provisional,
        decision: g0.decision,
        reasons: g0.reasons,
      });
      if (g0.decision === 'block') await this.d.mood.on(userId, 'guard_blocked', 'guard');
      return { decision: g0.decision, reasons: g0.reasons };
    }
    let q: InvestQuote;
    try {
      q = await this.d.invest.firm(asset, amountUsd, user.accountId);
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'invest firm quote failed');
      return {
        decision: 'needs_more_info',
        reasons: ["I couldn't get a live quote from NEAR Intents just now. Try again in a minute."],
      };
    }
    return this.createMoneyApproval({
      userId,
      bot,
      plan: { ...provisional, quoteId: q.quoteId },
      space: input.space,
      quote: { id: q.quoteId, expiresAt: q.expiresAt },
      facts: investFacts(q, this.d.now()),
      subcaption: `${input.note ? `${input.note} ` : ''}${q.amountOutDisplay} est. · tap to approve`,
    });
  }

  /**
   * Replace a pending invest approval whose quote expired or whose price moved beyond
   * slippage with a fresh card. Never relays the old signature. Returns the new approval id.
   */
  private async requote(row: ApprovalRow, why: 'expired' | 'price_moved'): Promise<string | null> {
    const plan = row.plan as MoneyPlan;
    if (plan.kind !== 'invest') return null;
    const space = this.cards.get(row.id)?.space;
    try {
      await this.d.approvals.transition(
        row.id,
        row.kind,
        'pending',
        why === 'expired' ? 'expired' : 'cancelled',
        why === 'expired' ? 'quote expired; re-quoted' : 'price moved beyond slippage; re-quoted',
      );
      await this.d.ledger.setStatusForApproval(row.id, 'released');
    } catch {
      return null; // someone else moved it
    }
    const line = why === 'expired' ? 'quote expired.' : 'price moved.';
    if (!space) {
      await this.updateCard(row.id, `${line} ask penny for a fresh one.`);
      return null;
    }
    await this.updateCard(row.id, `${line} sent you a fresh quote. nothing moved.`);
    const bot = row.botId && this.d.bots ? await this.d.bots.byId(row.botId) : null;
    const r = await this.createInvestApproval({
      userId: row.userId,
      bot,
      asset: plan.portfolioId,
      amountUsd: plan.amountUsd,
      space,
      note: why === 'expired' ? 'fresh quote.' : 'price moved, new quote.',
    });
    return r.decision === 'allow_with_approval' ? r.approvalId : null;
  }

  private requotedError(newId: string | null, why: 'expired' | 'price_moved'): ApprovalError {
    const what = why === 'expired' ? 'that quote expired' : 'the price moved past your slippage';
    return newId
      ? new ApprovalError(409, 'requoted', `${what}; a fresh card is in the thread (${newId})`)
      : new ApprovalError(410, 'expired', `${what}; ask penny for a fresh one`);
  }

  /** Face ID card for a bot that has write or money tools. No NEAR actions. */
  async createBotApproval(input: {
    userId: string;
    plan: CreateBotPlan;
    space: SpaceRef;
    riskLabel: string;
  }): Promise<{ approvalId: string; cardToken: string; url: string } | null> {
    const user = await this.d.users.byId(input.userId);
    const device = user ? await this.d.users.activeDevice(input.userId) : null;
    if (!user?.accountId || !device) return null;
    const now = this.d.now();
    const { token, hash } = issueCardToken();
    const id = newId('apr');
    const actions: NearAction[] = [];
    const p = input.plan.permissions;
    const facts = [
      { label: 'Tools', value: input.plan.toolIds.join(', ').slice(0, 80) || 'none' },
      { label: 'Can', value: input.riskLabel.slice(0, 80) },
    ];
    if (p.canMoveMoney && p.perTxCap && p.dailyCap) {
      facts.push({ label: 'Spending cap', value: `$${p.perTxCap} each · $${p.dailyCap}/day` });
    }
    await this.d.approvals.create({
      id,
      userId: input.userId,
      botId: null,
      kind: 'create_bot',
      plan: input.plan,
      title: titleFor(input.plan),
      amountDisplay: p.canMoveMoney && p.dailyCap ? `up to $${p.dailyCap}/day` : 'no money',
      amountMicros: 0n,
      facts,
      signerId: user.accountId,
      receiverId: user.accountId,
      actions,
      nonce: '0',
      maxBlockHeight: '0',
      expiresAt: new Date(now.getTime() + BOT_APPROVAL_TTL_MS),
      status: 'pending',
      planHash: planHash(input.plan, actions),
      cardTokenHash: hash,
    });
    const url = this.cardUrl(id, token);
    await this.sendCard(id, input.space, {
      approvalId: id,
      url,
      caption: titleFor(input.plan),
      subcaption: 'needs your Face ID',
      live: true,
    });
    return { approvalId: id, cardToken: token, url };
  }

  /**
   * Face ID card for a write in an outside app. No money, no NEAR actions.
   * The write itself runs in submit, after the device signature verifies.
   */
  async createWriteApproval(input: {
    userId: string;
    bot: BotRow | null;
    plan: WritePlan;
    space: SpaceRef;
  }): Promise<CreateResult> {
    const { userId, plan, bot } = input;
    const user = await this.d.users.byId(userId);
    const device = user ? await this.d.users.activeDevice(userId) : null;
    if (!user?.accountId || !device) {
      return {
        decision: 'needs_more_info',
        reasons: ['Finish setting up Penny on your iPhone first.'],
      };
    }
    if (!this.d.executeWrite) {
      return { decision: 'needs_more_info', reasons: ['That app is not connected yet.'] };
    }
    const problem = writeTargetProblem(plan.toolkit, plan.toolSlug, bot?.slug ?? null);
    if (problem) {
      await this.d.guardDecisions.record({
        userId,
        approvalId: null,
        plan,
        decision: 'block',
        reasons: [problem],
      });
      return { decision: 'block', reasons: [problem] };
    }
    const now = this.d.now();
    const { token, hash } = issueCardToken();
    const id = newId('apr');
    const actions: NearAction[] = [];
    await this.d.approvals.create({
      id,
      userId,
      botId: bot?.id ?? null,
      kind: 'write',
      plan,
      title: titleFor(plan),
      amountDisplay: 'no money',
      amountMicros: 0n,
      facts: writeFacts(plan),
      signerId: user.accountId,
      receiverId: user.accountId,
      actions,
      nonce: '0',
      maxBlockHeight: '0',
      expiresAt: new Date(now.getTime() + BOT_APPROVAL_TTL_MS),
      status: 'pending',
      planHash: planHash(plan, actions),
      cardTokenHash: hash,
    });
    await this.d.guardDecisions.record({
      userId,
      approvalId: id,
      plan,
      decision: 'allow_with_approval',
      reasons: ['write action requires Face ID approval'],
    });
    await this.d.mood.on(userId, 'approval_created');
    const url = this.cardUrl(id, token);
    await this.sendCard(id, input.space, {
      approvalId: id,
      url,
      caption: titleFor(plan),
      subcaption: 'needs your Face ID',
      live: true,
    });
    return {
      decision: 'allow_with_approval',
      approvalId: id,
      cardToken: token,
      url,
      reasons: ['write action requires Face ID approval'],
    };
  }

  private async sendCard(id: string, space: SpaceRef, card: ApprovalCard) {
    try {
      const handle = await this.d.messaging.sendCard(space, card);
      this.cards.set(id, { handle, space, card });
    } catch (e) {
      this.d.log.error({ err: (e as Error).message, approvalId: id }, 'card send failed');
    }
  }

  private async updateCard(id: string, subcaption: string, trailingCaption?: string) {
    const c = this.cards.get(id);
    if (!c) return;
    const next = { ...c.card, subcaption, ...(trailingCaption ? { trailingCaption } : {}) };
    try {
      await this.d.messaging.editCard(c.handle, next);
      c.card = next;
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message, approvalId: id }, 'card edit failed');
    }
  }

  // ---------- card-token authenticated operations ----------

  private async load(
    id: string,
    token: string | null,
    mode: 'read' | 'mutate',
  ): Promise<ApprovalRow> {
    const row = await this.d.approvals.get(id);
    // same error for unknown id and bad token: no existence oracle
    if (!row) throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    const c = checkCardToken({
      token,
      storedHash: row.cardTokenHash,
      expiresAt: row.expiresAt,
      now: this.d.now(),
      mode,
    });
    if (c === 'missing' || c === 'invalid')
      throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    if (c === 'expired') {
      if (row.status === 'pending' && row.kind === 'invest' && mode === 'mutate') {
        throw this.requotedError(await this.requote(row, 'expired'), 'expired');
      }
      if (row.status === 'pending') await this.expire(row);
      throw new ApprovalError(410, 'expired', 'this approval has expired');
    }
    return row;
  }

  async get(id: string, token: string | null): Promise<Approval> {
    return toApprovalDto(await this.load(id, token, 'read'));
  }

  async status(id: string, token: string | null): Promise<ApprovalStatusResponse> {
    const row = await this.load(id, token, 'read');
    return {
      id: row.id,
      status: row.status,
      txHash: row.txHash,
      steps: stepsFor(row.status, row.kind),
    };
  }

  private async expire(row: ApprovalRow) {
    try {
      await this.d.approvals.transition(row.id, row.kind, 'pending', 'expired', 'ttl elapsed');
      await this.d.ledger.setStatusForApproval(row.id, 'released');
      if (row.kind === 'create_bot') await this.d.onBotDeclined?.(row.id);
      await this.d.mood.on(row.userId, 'approval_expired');
      await this.updateCard(row.id, 'expired. ask penny for a fresh one.');
    } catch {
      /* already moved */
    }
  }

  async decline(id: string, token: string | null, reason?: string): Promise<{ status: string }> {
    const row = await this.load(id, token, 'mutate');
    if (row.status !== 'pending')
      throw new ApprovalError(409, 'not_pending', `approval is ${row.status}`);
    await this.d.approvals.transition(
      id,
      row.kind,
      'pending',
      'cancelled',
      reason ? `declined: ${reason}` : 'declined',
    );
    await this.d.ledger.setStatusForApproval(id, 'released');
    if (row.kind === 'create_bot') await this.d.onBotDeclined?.(id);
    await this.d.mood.on(row.userId, 'approval_declined');
    await this.updateCard(id, 'you said no. nothing moved.');
    return { status: 'cancelled' };
  }

  async submit(
    id: string,
    token: string | null,
    body: { signedDelegateAction: string } | { planSignature: string },
  ): Promise<{ status: string }> {
    const row = await this.load(id, token, 'mutate');
    if (row.status !== 'pending')
      throw new ApprovalError(409, 'not_pending', `approval is ${row.status}`);
    if (this.d.now().getTime() > row.expiresAt.getTime()) {
      if (row.kind === 'invest')
        throw this.requotedError(await this.requote(row, 'expired'), 'expired');
      await this.expire(row);
      throw new ApprovalError(410, 'expired', 'this approval has expired');
    }
    return row.kind === 'create_bot' || row.kind === 'write'
      ? this.submitPlanSigned(row, body)
      : this.submitMoney(row, body);
  }

  /** create_bot and write approvals: plain device signature over the plan message, no chain. */
  private async submitPlanSigned(
    row: ApprovalRow,
    body: { signedDelegateAction: string } | { planSignature: string },
  ) {
    if (!('planSignature' in body))
      throw new ApprovalError(400, 'wrong_body', 'this approval needs planSignature');
    const device = await this.d.users.activeDevice(row.userId);
    if (!device) throw new ApprovalError(403, 'no_device', 'no enrolled device');
    const msg = new TextEncoder().encode(planApprovalMessage(row.id, row.planHash));
    const sig = Buffer.from(body.planSignature, 'base64url');
    if (!verifyEd25519(device.publicKey, msg, sig)) {
      throw new ApprovalError(422, 'bad_signature', 'signature does not match the enrolled device');
    }
    await this.d.approvals.transition(
      row.id,
      row.kind,
      'pending',
      'signed',
      'device signature verified',
      {},
      { deviceId: device.id },
    );
    if (row.kind === 'create_bot') {
      await this.d.approvals.transition(row.id, row.kind, 'signed', 'settled', 'bot activated');
      await this.d.onBotApproved?.(row.id);
      await this.d.mood.on(row.userId, 'bot_created');
      await this.updateCard(row.id, 'live');
      return { status: 'settled' };
    }
    // write: execute in the outside app now, exactly once, after Face ID.
    const plan = row.plan as WritePlan;
    try {
      if (!this.d.executeWrite) throw new Error('connector unavailable');
      await this.d.executeWrite(row.userId, plan.toolkit, plan.toolSlug, plan.arguments);
    } catch (e) {
      await this.d.approvals.transition(
        row.id,
        row.kind,
        'signed',
        'failed',
        'write failed',
        {},
        {
          error: (e as Error).name,
        },
      );
      await this.d.mood.on(row.userId, 'approval_failed');
      await this.updateCard(row.id, 'that did not go through. nothing was changed.');
      return { status: 'failed' };
    }
    await this.d.approvals.transition(row.id, row.kind, 'signed', 'settled', 'write executed');
    await this.d.mood.on(row.userId, 'approval_settled');
    await this.updateCard(row.id, 'done ✓');
    return { status: 'settled' };
  }

  private async submitMoney(
    row: ApprovalRow,
    body: { signedDelegateAction: string } | { planSignature: string },
  ) {
    if (!('signedDelegateAction' in body)) {
      throw new ApprovalError(400, 'wrong_body', 'money approvals need signedDelegateAction');
    }
    const dto = toApprovalDto(row);
    // 1) re-run Guard against current state, excluding this approval's own
    // reservation. Bot caps and recipient must be preserved: load the bot
    // that created this approval, and keep velocity from other approvals.
    const plan = row.plan as MoneyPlan;
    const bot = row.botId && this.d.bots ? await this.d.bots.byId(row.botId) : null;
    const ctx = await this.guardContext(row.userId, bot);
    ctx.spentLast24hMicros =
      ctx.spentLast24hMicros > row.amountMicros ? ctx.spentLast24hMicros - row.amountMicros : 0n;
    // Exclude this approval from the velocity count; others still count.
    ctx.approvalsLast10Min = Math.max(0, ctx.approvalsLast10Min - 1);
    if (plan.kind === 'invest') ctx.quote = { id: plan.quoteId, expiresAt: row.expiresAt };
    const policy = await this.effectivePolicy(row.userId);
    // NEAR price: re-use the amount Guard sized at creation
    const recheckPlan: MoneyPlan =
      plan.kind === 'send' && plan.asset === 'NEAR'
        ? { kind: 'send', asset: 'USDC', amount: fromMicros(row.amountMicros), to: plan.to }
        : plan;
    const g = evaluate(recheckPlan, policy, ctx);
    if (g.decision === 'block') {
      await this.d.guardDecisions.record({
        userId: row.userId,
        approvalId: row.id,
        plan,
        decision: 'block',
        reasons: g.reasons,
      });
      await this.d.approvals.transition(
        row.id,
        row.kind,
        'pending',
        'cancelled',
        `guard re-check: ${g.reasons.join(' ')}`,
      );
      await this.d.ledger.setStatusForApproval(row.id, 'released');
      await this.d.mood.on(row.userId, 'guard_blocked', 'guard');
      await this.updateCard(row.id, 'blocked by Guard');
      throw new ApprovalError(409, 'guard_blocked', g.reasons.join(' '));
    }
    // 1b) invest: the quote must still be live and the price inside slippage, else re-card
    if (plan.kind === 'invest') await this.investPreflight(row, plan.quoteId);
    // 2) byte-for-byte verification of the signed delegate action
    const v = await this.d.chain.verifyDelegateAction(dto, body.signedDelegateAction);
    if (!v.ok) {
      this.d.log.warn({ approvalId: row.id, reason: v.reason }, 'delegate action rejected');
      throw new ApprovalError(
        422,
        'delegate_mismatch',
        'signed action does not match this approval',
      );
    }
    // 3) CAS to signed (single use), then relay
    await this.d.approvals.transition(
      row.id,
      row.kind,
      'pending',
      'signed',
      'delegate action verified',
    );
    await this.updateCard(row.id, 'sending…');
    const relay = await this.d.chain.relay(dto, body.signedDelegateAction);
    if (!relay.ok) {
      await this.d.approvals.transition(
        row.id,
        row.kind,
        'signed',
        'failed',
        `relay failed: ${relay.reason}`,
      );
      await this.d.ledger.setStatusForApproval(row.id, 'released');
      await this.d.mood.on(row.userId, 'approval_failed');
      await this.updateCard(row.id, 'failed, nothing was sent');
      throw new ApprovalError(502, 'relay_failed', 'could not send to NEAR');
    }
    await this.d.approvals.transition(
      row.id,
      row.kind,
      'signed',
      'relayed',
      relay.dryRun ? 'relayed (dry run)' : 'relayed',
      {
        txHash: relay.txHash,
      },
    );
    if (plan.kind === 'invest' && !relay.dryRun) {
      const dep = investDepositAddress(row.actions as NearAction[]);
      if (dep && this.d.invest) {
        try {
          await this.d.invest.notifyDeposit({
            txHash: relay.txHash,
            depositAddress: dep,
            sender: row.signerId,
          });
        } catch (e) {
          this.d.log.warn({ approvalId: row.id, err: (e as Error).name }, '1Click notify failed');
        }
        this.swapStates.set(row.id, 'pending');
        await this.updateCard(row.id, SWAP_LINE.pending, this.investLinks(dep, relay.txHash));
      }
    }
    const final = await this.refreshStatus(row.id);
    return { status: final };
  }

  private readonly swapStates = new Map<string, SwapState>();

  private investLinks(depositAddress: string, txHash: string | null): string {
    const parts = [`explorer.near-intents.org/transactions/${depositAddress}`];
    if (txHash) parts.push(`nearblocks.io/txns/${txHash}`);
    return parts.join(' · ');
  }

  /** Before relaying an invest: quote still live and price within slippage, else re-card. */
  private async investPreflight(row: ApprovalRow, quoteId: string): Promise<void> {
    const q = this.d.invest?.get(quoteId);
    if (!q || this.d.now().getTime() >= q.expiresAt.getTime()) {
      throw this.requotedError(await this.requote(row, 'expired'), 'expired');
    }
    let r: Awaited<ReturnType<InvestPort['recheck']>>;
    try {
      // biome-ignore lint/style/noNonNullAssertion: q exists only when invest is wired
      r = await this.d.invest!.recheck(q);
    } catch (e) {
      this.d.log.warn({ approvalId: row.id, err: (e as Error).name }, 'invest recheck failed');
      throw new ApprovalError(502, 'price_check_failed', "couldn't confirm the price; try again");
    }
    if (!r.ok) throw this.requotedError(await this.requote(row, 'price_moved'), 'price_moved');
  }

  /** Poll chain status for a relayed approval and settle/fail it. */
  /** Poller job: advance every relayed approval toward settled/failed. */
  async refreshRelayed(): Promise<{ checked: number; settled: number; failed: number }> {
    const rows = await this.d.approvals.relayed();
    let settled = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const s = await this.refreshStatus(row.id);
        if (s === 'settled') settled += 1;
        if (s === 'failed') failed += 1;
      } catch (e) {
        this.d.log.warn({ approvalId: row.id, err: (e as Error).name }, 'status poll failed');
      }
    }
    return { checked: rows.length, settled, failed };
  }

  async refreshStatus(id: string): Promise<string> {
    const row = await this.d.approvals.get(id);
    if (!row) throw new ApprovalError(404, 'not_found', 'not found');
    if (row.status !== 'relayed' || !row.txHash) return row.status;
    const s = await this.d.chain.txStatus(row.txHash);
    if (s === 'pending') return 'relayed';
    if (s === 'settled' && row.kind === 'invest' && this.d.invest) {
      const events = await this.d.approvals.events(id);
      const dry = events.some((e) => e.reason === 'relayed (dry run)');
      const dep = investDepositAddress(row.actions as NearAction[]);
      if (!dry && dep) return this.refreshSwap(row, dep);
    }
    if (s === 'settled') {
      await this.d.approvals.transition(id, row.kind, 'relayed', 'settled', 'final on chain');
      await this.d.ledger.setStatusForApproval(id, 'settled');
      await this.d.mood.on(row.userId, 'approval_settled');
      await this.updateCard(id, 'done ✓');
      return 'settled';
    }
    await this.d.approvals.transition(id, row.kind, 'relayed', 'failed', 'chain reported failure');
    await this.d.ledger.setStatusForApproval(id, 'released');
    await this.d.mood.on(row.userId, 'approval_failed');
    await this.updateCard(id, 'failed');
    return 'failed';
  }

  /** Deposit landed on NEAR; follow the 1Click swap and update the card in place. */
  private async refreshSwap(row: ApprovalRow, dep: string): Promise<string> {
    // biome-ignore lint/style/noNonNullAssertion: caller checked invest is wired
    const view = await this.d.invest!.status(dep);
    const links = this.investLinks(dep, row.txHash);
    const line =
      view.state === 'success' && view.amountOutDisplay
        ? `success ✓ got ${view.amountOutDisplay}`
        : SWAP_LINE[view.state];
    if (view.state === 'pending' || view.state === 'processing') {
      if (this.swapStates.get(row.id) !== view.state) {
        this.swapStates.set(row.id, view.state);
        await this.updateCard(row.id, line, links);
      }
      return 'relayed';
    }
    this.swapStates.delete(row.id);
    if (view.state === 'success') {
      await this.d.approvals.transition(row.id, row.kind, 'relayed', 'settled', 'swap success');
      await this.d.ledger.setStatusForApproval(row.id, 'settled');
      await this.d.mood.on(row.userId, 'approval_settled');
      await this.updateCard(row.id, line, links);
      return 'settled';
    }
    await this.d.approvals.transition(
      row.id,
      row.kind,
      'relayed',
      'failed',
      view.state === 'refunded'
        ? `swap refunded${view.refundReason ? `: ${view.refundReason}` : ''}`
        : 'swap failed',
    );
    await this.d.ledger.setStatusForApproval(row.id, 'released');
    await this.d.mood.on(row.userId, 'approval_failed');
    await this.updateCard(row.id, line, links);
    return 'failed';
  }

  /** Sweep pending approvals past expiry. Run on an interval. */
  async expireDue(): Promise<number> {
    const due = await this.d.approvals.pendingExpiredBefore(this.d.now());
    for (const r of due) if (!isTerminal(r.status)) await this.expire(r);
    return due.length;
  }
}
