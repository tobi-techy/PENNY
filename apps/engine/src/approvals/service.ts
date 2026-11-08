import {
  type Approval,
  type ApprovalByTokenResponse,
  type ApprovalStatusResponse,
  approvalActionOf,
  approvalHash,
  approvalSignMessage,
  type CardState,
  type CreateBotPlan,
  compareDecimal,
  Decimal,
  formatUsd,
  fromMicros,
  type IntentPlan,
  type MoneyPlan,
  type NearAction,
  type PasskeyApproveBody,
  planAmount,
  planApprovalMessage,
  planHash,
  planRecipient,
  type SignBody,
  toMicros,
  type WritePlan,
} from '@penny/shared';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { MoodService } from '../brain/mood.ts';
import type { CardSender } from '../cards/sender.ts';
import { writeTargetProblem } from '../connectors/composio.ts';
import {
  evaluate,
  type GuardContext,
  type GuardPolicy,
  type GuardResult,
  QUOTE_MIN_REMAINING_MS,
} from '../guard/policy.ts';
import { randomToken, sha256Hex, verifyEd25519 } from '../lib/crypto.ts';
import { newId } from '../lib/ids.ts';
import type { Logger } from '../lib/logger.ts';
import {
  type InvestPort,
  type InvestQuote,
  isInvestAsset,
  type SwapState,
} from '../market/invest.ts';
import type { ChainPort } from '../ports/chain.ts';
import type { MessagingPort, SpaceRef } from '../ports/messaging.ts';
import type { ApprovalRow, ApprovalsRepo } from '../repo/approvals.ts';
import type { BotRow, BotsRepo } from '../repo/bots.ts';
import type { CardsRepo, PasskeysRepo } from '../repo/cards.ts';
import type { GuardDecisionsRepo } from '../repo/infra.ts';
import { DAY_MS, type LedgerRepo } from '../repo/ledger.ts';
import type { UsersRepo } from '../repo/users.ts';
import { checkCardToken, issueCardToken, READ_GRACE_MS } from './card-token.ts';
import { isTerminal, stepsFor } from './state.ts';
import { writeFacts } from './write-facts.ts';

/** Approvals tied to a price (invest quotes) live 90 seconds at most. */
export const QUOTE_TTL_CAP_MS = 90_000;
/** Plain sends, bills and errands: 10 minutes. */
export const SEND_TTL_MS = 10 * 60_000;
export const BOT_APPROVAL_TTL_MS = 10 * 60_000;
/** A failed check or an expired card is replaced at most this many times in a row. */
export const MAX_REISSUES = 3;
/** User copy when the user froze Penny. */
export const FROZEN_TEXT = 'Penny is frozen. Text unfreeze to start again.';
export const REQUOTE_AFTER_EXPIRY_MS = 10 * 60_000;
const TEN_MIN = 10 * 60_000;

export type Clock = () => Date;

export class ApprovalError extends Error {
  override name = 'ApprovalError';
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 423 | 502,
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
  /** Every card goes through here (live vs link picker, edit in place). */
  cards: CardSender;
  cardsRepo: CardsRepo;
  passkeys: PasskeysRepo;
  mood: MoodService;
  log: Logger;
  publicBaseUrl: string;
  /** Explorer for receipts, e.g. https://testnet.nearblocks.io */
  explorerBaseUrl?: string;
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
  /** A new-bot card was replaced by a fresh one: the bot follows the new approval. */
  onBotReissued?: (fromApprovalId: string, toApprovalId: string) => Promise<void>;
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

// User-facing card lines: plain words only (no chain or swap jargon; see docs/DESIGN.md).
const SWAP_LINE: Record<SwapState, string> = {
  pending: 'Sending…',
  processing: 'Buying now…',
  success: 'Done',
  refunded: 'Refunded to you',
  failed: "Didn't go through. Any money taken comes back to you.",
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

/** Card rows for an invest preview/approval (max 7, plus the daily limit). Plain words only. */
export function investFacts(q: InvestQuote, now: Date): { label: string; value: string }[] {
  const secs = Math.max(0, Math.round((q.expiresAt.getTime() - now.getTime()) / 1000));
  const good = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs} sec`;
  // The iPhone card shows the first three rows (CardModel prefix(3)): what you pay,
  // what you get (with the floor), and the fee. The fee includes 1Click's 0.2% keyless fee
  // when no partner key is set (q.keyless); that detail stays in logs and docs.
  return [
    { label: 'You pay', value: `$${q.amountUsd}` },
    {
      label: "You'll get",
      value: `about ${q.amountOutDisplay}, at least ${q.minOutDisplay}`.slice(0, 80),
    },
    { label: 'Fee', value: `$${roundUpCents(q.feeUsd)}` },
    { label: 'Price', value: q.rateDisplay },
    { label: 'Price good for', value: good },
    { label: 'Goes to', value: 'your Penny wallet' },
  ];
}

/** "0.002469" -> "0.01": rounds up to the cent, so a non-zero fee never shows as $0.00. */
export function roundUpCents(v: string): string {
  const micros = toMicros(v);
  const cents = (micros + 9_999n) / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Card title: the outcome in plain words ("Send 0.1 NEAR"). */
function cardTitleFor(plan: IntentPlan): string {
  switch (plan.kind) {
    case 'send':
      return `Send ${plan.amount} ${plan.asset}`;
    case 'invest':
      return `Buy $${plan.amountUsd} of ${plan.portfolioId}`.slice(0, 80);
    case 'pay_bill':
      return `Pay ${plan.payee}`.slice(0, 80);
    case 'errand':
      return 'Pay for an errand';
    case 'split':
      return 'Split';
    case 'create_bot':
      return `New bot · ${plan.name}`.slice(0, 80);
    case 'write':
      return plan.title.slice(0, 80);
  }
}

function titleFor(plan: IntentPlan): string {
  switch (plan.kind) {
    case 'invest':
      return `Buying $${plan.amountUsd} of ${plan.portfolioId}`.slice(0, 80);
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

/** Card type and crew agent for an approval kind (docs/DESIGN.md section 4). */
function cardTypeFor(kind: ApprovalRow['kind']): string {
  switch (kind) {
    case 'create_bot':
      return 'new_bot';
    default:
      return kind;
  }
}

function agentFor(kind: ApprovalRow['kind'], bot: BotRow | null): string {
  if (bot && !bot.builtIn) return bot.slug;
  if (kind === 'invest') return 'invest';
  if (kind === 'pay_bill') return 'finance';
  if (kind === 'write') return bot?.slug ?? 'mail';
  return 'penny';
}

/** The big number on a money card, in the asset the user named. */
function amountFor(plan: IntentPlan, amountDisplay: string): string {
  if (plan.kind === 'send' && plan.asset === 'NEAR') return `${plan.amount} NEAR`;
  return amountDisplay;
}

const APPROVE_BUTTONS = [
  { id: 'approve', label: 'Approve with Face ID', action: 'approve' as const },
  { id: 'decline', label: 'Not now', action: 'decline' as const },
];

export class ApprovalService {
  constructor(private readonly d: ApprovalDeps) {}

  private nearUsdFromRow(row: ApprovalRow): bigint | undefined {
    // micro-USD per NEAR from what Guard sized at creation (used for re-issues)
    const plan = row.plan as MoneyPlan;
    if (plan.kind !== 'send' || plan.asset !== 'NEAR') return undefined;
    const microNear = toMicros(plan.amount);
    return microNear > 0n ? (row.amountMicros * 1_000_000n) / microNear : undefined;
  }

  /** Guard said no: the Blocked card, never an approval card. */
  async sendBlockedCard(
    userId: string,
    space: SpaceRef,
    reasons: string[],
    title = 'Not today',
  ): Promise<void> {
    await this.d.cards.send({
      userId,
      space,
      agent: 'guard',
      kind: 'info',
      type: 'guard_block',
      title,
      lines: [{ value: (reasons[0] ?? "That's outside your limits.").slice(0, 120) }],
      buttons: [{ id: 'notme', label: 'Not me', action: 'freeze' }],
      state: 'blocked',
    });
  }

  private async frozen(userId: string): Promise<boolean> {
    const u = await this.d.users.byId(userId);
    return Boolean(u?.frozenAt);
  }

  /** 32 random bytes (single use) and the approval hash, stored with the approval. */
  private challengeFields(id: string, plan: IntentPlan, expiresAt: Date, ph: string) {
    return {
      challenge: randomToken(32),
      approvalHash: approvalHash({
        id,
        action: approvalActionOf(plan),
        expiresAt: expiresAt.toISOString(),
        planHash: ph,
      }),
    };
  }

  /** Recompute the hash from the stored row: the action must still match what was approved. */
  private hashStillMatches(row: ApprovalRow): boolean {
    if (!row.approvalHash) return false;
    const plan = row.plan as IntentPlan;
    if (planHash(plan, row.actions as NearAction[]) !== row.planHash) return false;
    return (
      approvalHash({
        id: row.id,
        action: approvalActionOf(plan),
        expiresAt: row.expiresAt.toISOString(),
        planHash: row.planHash,
      }) === row.approvalHash
    );
  }

  private async sendApprovalCard(
    approvalId: string,
    space: SpaceRef,
    tok: { token: string; hash: string },
    c: {
      userId: string;
      agent: string;
      type: string;
      title: string;
      amount?: string;
      lines: { label: string; value: string }[];
      expiresAt: Date;
      subcaption: string;
    },
  ): Promise<string> {
    try {
      const sent = await this.d.cards.send({
        userId: c.userId,
        space,
        agent: c.agent,
        kind: 'approval',
        type: c.type,
        title: c.title,
        ...(c.amount ? { amount: c.amount } : {}),
        lines: c.lines.map((l) => ({ label: l.label.slice(0, 40), value: l.value.slice(0, 120) })),
        buttons: APPROVE_BUTTONS,
        state: 'ready',
        approvalId,
        expiresAt: c.expiresAt,
        tokenExpiresAt: c.expiresAt,
        token: tok,
        subcaption: c.subcaption,
      });
      await this.d.approvals.setCardId(approvalId, sent.card.id);
      if (sent.ref) await this.d.approvals.setCardHandle(approvalId, sent.ref, space);
      return sent.url;
    } catch (e) {
      this.d.log.error({ err: (e as Error).message, approvalId }, 'card send failed');
      return this.d.cards.url(tok.token);
    }
  }

  /** Move the approval's card to a new state (live: edit in place; link: a fresh card). */
  private async updateCard(
    approvalId: string,
    state: CardState,
    subcaption?: string,
    extra: { receiptUrl?: string } = {},
  ): Promise<void> {
    try {
      const card = await this.d.cardsRepo.byApprovalId(approvalId);
      if (!card) return;
      await this.d.cards.update(
        card.id,
        {
          state,
          ...(extra.receiptUrl ? { receiptUrl: extra.receiptUrl } : {}),
          ...(state === 'sent' || state === 'blocked' || state === 'expired' || state === 'failed'
            ? {
                buttons:
                  state === 'blocked'
                    ? [{ id: 'notme', label: 'Not me', action: 'freeze' }]
                    : state === 'expired'
                      ? [{ id: 'renew', label: 'Get a new card', action: 'renew' }]
                      : extra.receiptUrl
                        ? [
                            {
                              id: 'receipt',
                              label: 'View receipt',
                              action: 'open',
                              value: extra.receiptUrl,
                            },
                          ]
                        : [],
              }
            : state === 'approving' || state === 'declined' || state === 'done'
              ? { buttons: [] }
              : {}),
        },
        subcaption ? { subcaption } : {},
      );
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message, approvalId }, 'card update failed');
    }
  }

  /** The explorer link for a settled move (never for a dry run). */
  private receiptOpts(txHash: string | null, dryRun: boolean): { receiptUrl?: string } {
    if (!txHash || dryRun || !this.d.explorerBaseUrl) return {};
    return { receiptUrl: `${this.d.explorerBaseUrl.replace(/\/$/, '')}/txns/${txHash}` };
  }

  private async spaceOf(approvalId: string): Promise<SpaceRef | null> {
    const card = await this.d.cardsRepo.byApprovalId(approvalId);
    return card?.space ?? null;
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
    reissuedFrom?: string;
  }): Promise<CreateResult> {
    const { userId, plan, bot } = input;
    if (await this.frozen(userId)) return { decision: 'block', reasons: [FROZEN_TEXT] };
    const user = await this.d.users.byId(userId);
    const device = user ? await this.d.users.activeDevice(userId) : null;
    if (!user?.accountId || !device) {
      return {
        decision: 'needs_more_info',
        reasons: ['set up approvals first: tap the setup card penny sent you, then ask again.'],
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
      if (g.decision === 'block') {
        await this.d.mood.on(userId, 'guard_blocked', 'guard');
        await this.sendBlockedCard(userId, input.space, g.reasons);
      }
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
        await this.sendBlockedCard(userId, input.space, reasons);
        return { decision: 'block', reasons };
      }
    }
    const now = this.d.now();
    // 90 s for anything priced by a quote, 10 min for plain sends, bills and errands
    const ttl = input.quote || plan.kind === 'invest' ? QUOTE_TTL_CAP_MS : SEND_TTL_MS;
    const cap = now.getTime() + ttl;
    const expiresAt = new Date(Math.min(cap, input.quote ? input.quote.expiresAt.getTime() : cap));
    const signing = await this.d.chain.prepareSigning(
      user.accountId,
      device.publicKey,
      Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
    );
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

    const ph = planHash(plan, built.actions);
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
      planHash: ph,
      cardTokenHash: hash,
      ...this.challengeFields(id, plan, expiresAt, ph),
      reissuedFrom: input.reissuedFrom ?? null,
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
    const url = await this.sendApprovalCard(
      id,
      input.space,
      { token, hash },
      {
        userId,
        agent: agentFor(plan.kind, bot),
        type: cardTypeFor(plan.kind),
        title: cardTitleFor(plan),
        amount: amountFor(plan, amountDisplay),
        lines: facts.slice(0, 4),
        expiresAt,
        subcaption: input.subcaption ?? (recipient ? `to ${recipient}` : 'tap to approve'),
      },
    );
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
  async previewInvest(userId: string, asset: string, amountUsd: string, bot: BotRow | null = null) {
    if (!this.d.invest) return { ok: false, error: "Investing isn't switched on yet." };
    if (!isInvestAsset(asset)) return { ok: false, error: 'I can buy ETH, SOL or NEAR for now.' };
    if (!Decimal.safeParse(amountUsd).success) return { ok: false, error: 'How much, in dollars?' };
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
    const g = await this.checkGuard(userId, plan, bot, {
      quote: { id: 'preview', expiresAt: new Date(now.getTime() + 60_000) },
    });
    let q: InvestQuote;
    try {
      q = await this.d.invest.preview(asset, amountUsd, user.accountId);
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'invest preview failed');
      return { ok: false, error: "I couldn't get a price just now. Try again in a minute." };
    }
    return {
      ok: true,
      facts: investFacts(q, now),
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
    reissuedFrom?: string;
  }): Promise<CreateResult> {
    const { userId, bot, asset, amountUsd } = input;
    if (await this.frozen(userId)) return { decision: 'block', reasons: [FROZEN_TEXT] };
    if (!this.d.invest)
      return { decision: 'needs_more_info', reasons: ["Investing isn't switched on yet."] };
    if (!isInvestAsset(asset))
      return { decision: 'block', reasons: ['I can only buy ETH, SOL or NEAR for now.'] };
    if (!Decimal.safeParse(amountUsd).success)
      return { decision: 'needs_more_info', reasons: ['How much, in dollars?'] };
    const user = await this.d.users.byId(userId);
    const device = user ? await this.d.users.activeDevice(userId) : null;
    if (!user?.accountId || !device) {
      return {
        decision: 'needs_more_info',
        reasons: ['set up approvals first: tap the setup card penny sent you, then ask again.'],
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
      if (g0.decision === 'block') {
        await this.d.mood.on(userId, 'guard_blocked', 'guard');
        await this.sendBlockedCard(userId, input.space, g0.reasons);
      }
      return { decision: g0.decision, reasons: g0.reasons };
    }
    let q: InvestQuote;
    try {
      q = await this.d.invest.firm(asset, amountUsd, user.accountId);
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'invest firm quote failed');
      return {
        decision: 'needs_more_info',
        reasons: ["I couldn't get a price just now. Try again in a minute."],
      };
    }
    return this.createMoneyApproval({
      userId,
      bot,
      plan: { ...provisional, quoteId: q.quoteId },
      space: input.space,
      quote: { id: q.quoteId, expiresAt: q.expiresAt },
      facts: investFacts(q, this.d.now()),
      subcaption: `${input.note ? `${input.note} ` : ''}You'll get about ${q.amountOutDisplay} · tap to approve`,
      ...(input.reissuedFrom ? { reissuedFrom: input.reissuedFrom } : {}),
    });
  }

  /**
   * Replace a pending invest approval whose quote expired or whose price moved beyond
   * slippage with a fresh card. Never relays the old signature. Returns the new approval id.
   */
  private async requote(row: ApprovalRow, why: 'expired' | 'price_moved'): Promise<string | null> {
    const plan = row.plan as MoneyPlan;
    if (plan.kind !== 'invest') return null;
    const space = await this.spaceOf(row.id);
    if (this.requoted.has(row.id)) return null;
    this.requoted.add(row.id);
    if (row.status === 'pending') {
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
    }
    if (!space) {
      await this.updateCard(row.id, 'expired', 'Price expired. Ask Penny again. Nothing moved.');
      return null;
    }
    const bot = row.botId && this.d.bots ? await this.d.bots.byId(row.botId) : null;
    const r = await this.createInvestApproval({
      userId: row.userId,
      bot,
      asset: plan.portfolioId,
      amountUsd: plan.amountUsd,
      space,
      note: 'New price.',
      reissuedFrom: row.id,
    });
    if (r.decision === 'allow_with_approval') {
      await this.updateCard(
        row.id,
        'expired',
        'Price changed, check the new amount. Nothing moved.',
      );
      return r.approvalId;
    }
    await this.updateCard(row.id, 'expired', 'Price changed. Ask Penny again. Nothing moved.');
    return null;
  }

  /** approval ids already re-quoted once (a card is never re-quoted twice) */
  private readonly requoted = new Set<string>();

  /**
   * An approve tap on an invest card whose quote ran out re-quotes: while still pending,
   * or within 10 min after the expiry sweeper marked it expired (the sweep runs every 10 s).
   */
  private canRequoteExpired(row: ApprovalRow): boolean {
    if (row.kind !== 'invest' || this.requoted.has(row.id)) return false;
    if (row.status === 'pending') return true;
    return (
      row.status === 'expired' &&
      this.d.now().getTime() - row.expiresAt.getTime() < REQUOTE_AFTER_EXPIRY_MS
    );
  }

  private requotedError(newId: string | null, why: 'expired' | 'price_moved'): ApprovalError {
    // user-facing; the reason and new approval id go to logs only
    this.d.log.info({ why, newApprovalId: newId }, 'invest re-quoted');
    return newId
      ? new ApprovalError(409, 'requoted', 'Price changed, check the new amount in your messages.')
      : new ApprovalError(410, 'expired', 'This expired. Ask Penny again.');
  }

  /** Face ID card for a bot that has write or money tools. No NEAR actions. */
  async createBotApproval(input: {
    userId: string;
    plan: CreateBotPlan;
    space: SpaceRef;
    riskLabel: string;
    reissuedFrom?: string;
  }): Promise<{ approvalId: string; cardToken: string; url: string } | null> {
    if (await this.frozen(input.userId)) return null;
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
    const expiresAt = new Date(now.getTime() + BOT_APPROVAL_TTL_MS);
    const ph = planHash(input.plan, actions);
    const amountDisplay = p.canMoveMoney && p.dailyCap ? `up to $${p.dailyCap}/day` : 'no money';
    await this.d.approvals.create({
      id,
      userId: input.userId,
      botId: null,
      kind: 'create_bot',
      plan: input.plan,
      title: titleFor(input.plan),
      amountDisplay,
      amountMicros: 0n,
      facts,
      signerId: user.accountId,
      receiverId: user.accountId,
      actions,
      nonce: '0',
      maxBlockHeight: '0',
      expiresAt,
      status: 'pending',
      planHash: ph,
      cardTokenHash: hash,
      ...this.challengeFields(id, input.plan, expiresAt, ph),
      reissuedFrom: input.reissuedFrom ?? null,
    });
    const url = await this.sendApprovalCard(
      id,
      input.space,
      { token, hash },
      {
        userId: input.userId,
        agent: 'penny',
        type: 'new_bot',
        title: cardTitleFor(input.plan),
        lines: facts,
        expiresAt,
        subcaption: 'needs your Face ID',
      },
    );
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
    reissuedFrom?: string;
    /** Turn this existing info card (e.g. an email draft) into the approval card. */
    fromCard?: { id: string; tokenHash: string };
  }): Promise<CreateResult> {
    const { userId, plan, bot } = input;
    if (await this.frozen(userId)) return { decision: 'block', reasons: [FROZEN_TEXT] };
    const user = await this.d.users.byId(userId);
    const device = user ? await this.d.users.activeDevice(userId) : null;
    if (!user?.accountId || !device) {
      return {
        decision: 'needs_more_info',
        reasons: ['set up approvals first: tap the setup card penny sent you, then ask again.'],
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
      await this.sendBlockedCard(userId, input.space, [problem]);
      return { decision: 'block', reasons: [problem] };
    }
    const now = this.d.now();
    const issued = issueCardToken();
    // An info card that becomes an approval card keeps its URL (same token hash).
    const hash = input.fromCard ? input.fromCard.tokenHash : issued.hash;
    const token = input.fromCard ? '' : issued.token;
    const id = newId('apr');
    const actions: NearAction[] = [];
    const expiresAt = new Date(now.getTime() + BOT_APPROVAL_TTL_MS);
    const ph = planHash(plan, actions);
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
      expiresAt,
      status: 'pending',
      planHash: ph,
      cardTokenHash: hash,
      ...this.challengeFields(id, plan, expiresAt, ph),
      reissuedFrom: input.reissuedFrom ?? null,
      ...(input.fromCard ? { cardId: input.fromCard.id } : {}),
    });
    await this.d.guardDecisions.record({
      userId,
      approvalId: id,
      plan,
      decision: 'allow_with_approval',
      reasons: ['write action requires Face ID approval'],
    });
    await this.d.mood.on(userId, 'approval_created');
    let url: string;
    if (input.fromCard) {
      // the same card turns into an approval card, edited in place
      await this.d.cards.update(input.fromCard.id, {
        kind: 'approval',
        approvalId: id,
        state: 'ready',
        buttons: APPROVE_BUTTONS,
        expiresAt,
        tokenExpiresAt: expiresAt,
      });
      url = '';
    } else {
      url = await this.sendApprovalCard(
        id,
        input.space,
        { token, hash },
        {
          userId,
          agent: agentFor('write', bot),
          type: 'write',
          title: cardTitleFor(plan),
          lines: writeFacts(plan).slice(0, 4),
          expiresAt,
          subcaption: 'needs your Face ID',
        },
      );
    }
    return {
      decision: 'allow_with_approval',
      approvalId: id,
      cardToken: token,
      url,
      reasons: ['write action requires Face ID approval'],
    };
  }

  // ---------- card-token authenticated operations ----------

  private async load(
    id: string,
    token: string | null,
    mode: 'read' | 'mutate',
    intent: 'read' | 'submit' | 'decline' = mode === 'read' ? 'read' : 'decline',
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
      // Only an approve (submit) on an invest card re-quotes; decline never buys a new quote.
      if (intent === 'submit' && this.canRequoteExpired(row)) {
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

  // ---------- card token: one URL for the extension and the link page ----------

  /**
   * GET /v1/approvals/by-token/:token. The card (any type) plus, for approval cards,
   * the action, approval hash, single-use challenge and expiry. The challenge is only
   * handed out while the approval is pending, unexpired and the challenge unused.
   */
  async getByToken(token: string): Promise<ApprovalByTokenResponse> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    const card = await this.d.cardsRepo.byTokenHash(sha256Hex(token));
    const now = this.d.now();
    if (!card || now.getTime() > card.tokenExpiresAt.getTime() + READ_GRACE_MS) {
      throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    }
    let row = card.approvalId ? await this.d.approvals.get(card.approvalId) : null;
    if (row && row.status === 'pending' && now.getTime() > row.expiresAt.getTime()) {
      await this.expire(row);
      row = await this.d.approvals.get(row.id);
    }
    const fresh = (await this.d.cards.get(card.id)) ?? null;
    if (!fresh) throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    if (!row) return { card: fresh };
    const usable =
      row.status === 'pending' && !row.challengeUsedAt && now.getTime() <= row.expiresAt.getTime();
    const device = await this.d.users.activeDevice(row.userId);
    const passkeys =
      device?.platform === 'web_passkey'
        ? (await this.d.passkeys.activeForUser(row.userId)).map((p) => p.credentialId)
        : undefined;
    return {
      card: fresh,
      approval: {
        id: row.id,
        action: approvalActionOf(row.plan as IntentPlan),
        approvalHash: row.approvalHash ?? '',
        ...(usable && row.challenge ? { challenge: row.challenge } : {}),
        expiresAt: row.expiresAt.toISOString(),
        status: row.status,
        ...(passkeys ? { passkeys } : {}),
        detail: toApprovalDto(row),
      },
    };
  }

  /**
   * Common pre-checks for both approve paths. Order matters: the challenge is
   * burned first, so any attempt (good or bad) uses it up.
   */
  private async precheck(id: string, token: string | null): Promise<ApprovalRow> {
    const row = await this.load(id, token, 'mutate', 'submit');
    if (await this.frozen(row.userId)) {
      throw new ApprovalError(423, 'frozen', FROZEN_TEXT);
    }
    if (row.status !== 'pending')
      throw new ApprovalError(409, 'not_pending', `approval is ${row.status}`);
    if (!row.challenge || !row.approvalHash) {
      throw new ApprovalError(409, 'no_challenge', 'this card is too old. ask penny again.');
    }
    if (!(await this.d.approvals.burnChallenge(row.id, this.d.now()))) {
      // already used: a replay or a second tap. Never reuse an old signature.
      throw new ApprovalError(409, 'challenge_used', 'this card was already used.');
    }
    return row;
  }

  /**
   * A check failed right before sending: the approval is expired (never retried
   * with the same signature) and Penny sends a fresh card.
   */
  private async failAndReissue(row: ApprovalRow, reason: string): Promise<string | null> {
    try {
      await this.d.approvals.transition(
        row.id,
        row.kind,
        'pending',
        'expired',
        `check failed: ${reason}`,
      );
      await this.d.ledger.setStatusForApproval(row.id, 'released');
    } catch {
      return null; // someone else moved it
    }
    this.d.log.warn({ approvalId: row.id, reason }, 'approval check failed; re-issuing');
    const next = await this.reissue(row);
    if (row.kind === 'create_bot' && !next) await this.d.onBotDeclined?.(row.id);
    await this.updateCard(
      row.id,
      'expired',
      next ? "that didn't check out. here's a new card." : 'expired. ask penny again.',
    );
    return next;
  }

  /** How many times this approval has already been replaced. */
  private async reissueDepth(row: ApprovalRow): Promise<number> {
    let depth = 0;
    let from = row.reissuedFrom;
    while (from && depth <= MAX_REISSUES) {
      depth += 1;
      from = (await this.d.approvals.get(from))?.reissuedFrom ?? null;
    }
    return depth;
  }

  /**
   * A fresh approval for the same thing: Guard runs again, a new challenge, a new
   * card. Returns the new approval id, or null when it can't (Guard said no, too
   * many re-issues, already re-issued, or frozen).
   */
  async reissue(row: ApprovalRow): Promise<string | null> {
    if (await this.d.approvals.byReissuedFrom(row.id)) return null;
    if ((await this.reissueDepth(row)) >= MAX_REISSUES) return null;
    if (await this.frozen(row.userId)) return null;
    const space = await this.spaceOf(row.id);
    if (!space) return null;
    const bot = row.botId && this.d.bots ? await this.d.bots.byId(row.botId) : null;
    const plan = row.plan as IntentPlan;
    if (plan.kind === 'invest') {
      this.requoted.add(row.id);
      const r = await this.createInvestApproval({
        userId: row.userId,
        bot,
        asset: plan.portfolioId,
        amountUsd: plan.amountUsd,
        space,
        reissuedFrom: row.id,
      });
      return r.decision === 'allow_with_approval' ? r.approvalId : null;
    }
    if (plan.kind === 'write') {
      const r = await this.createWriteApproval({
        userId: row.userId,
        bot,
        plan,
        space,
        reissuedFrom: row.id,
      });
      return r.decision === 'allow_with_approval' ? r.approvalId : null;
    }
    if (plan.kind === 'create_bot') {
      const riskLabel = row.facts.find((f) => f.label === 'Can')?.value ?? 'Can act for you';
      const r = await this.createBotApproval({
        userId: row.userId,
        plan,
        space,
        riskLabel,
        reissuedFrom: row.id,
      });
      if (r) await this.d.onBotReissued?.(row.id, r.approvalId);
      return r?.approvalId ?? null;
    }
    if (plan.kind === 'split') return null;
    const price = this.nearUsdFromRow(row);
    const r = await this.createMoneyApproval({
      userId: row.userId,
      bot,
      plan,
      space,
      ...(price !== undefined ? { nearUsdPriceMicros: price } : {}),
      reissuedFrom: row.id,
    });
    return r.decision === 'allow_with_approval' ? r.approvalId : null;
  }

  /** "Get a new card" on an expired card. Card token auth (read grace applies). */
  async renewByToken(token: string): Promise<{ approvalId: string | null }> {
    const view = await this.getByToken(token);
    const id = view.card.approvalId;
    if (!id) throw new ApprovalError(409, 'not_approval', 'nothing to renew');
    const row = await this.d.approvals.get(id);
    if (!row) throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    if (row.status === 'pending' && this.d.now().getTime() > row.expiresAt.getTime())
      await this.expire(row);
    const now = await this.d.approvals.get(id);
    if (!now || (now.status !== 'expired' && now.status !== 'failed')) {
      throw new ApprovalError(409, 'not_expired', 'this card is still live');
    }
    const existing = await this.d.approvals.byReissuedFrom(id);
    if (existing) return { approvalId: existing.id };
    return { approvalId: await this.reissue(now) };
  }

  /**
   * iOS app path. POST /v1/approvals/:id/sign: the enrolled device signed
   * approvalSignMessage(approvalHash, challenge) behind Face ID, plus the signed
   * action. Checks, in order: card token, not frozen, pending, challenge unused
   * (burned now), device enrolled to this user and not revoked, not expired, the
   * action still matches the hash, the signature matches the enrolled key. Then
   * the existing relay path (Guard again, byte-for-byte action match, block-height
   * deadline). Any failed check expires the approval and sends a new card.
   */
  async signWithDevice(
    id: string,
    token: string | null,
    body: SignBody,
  ): Promise<{ status: string }> {
    const row = await this.precheck(id, token);
    const device = await this.d.users.deviceById(body.deviceId);
    const fail = async (code: string, msg: string, status: 403 | 410 | 422 = 422) => {
      await this.failAndReissue(row, code);
      return new ApprovalError(status, code, msg);
    };
    if (!device || device.userId !== row.userId || device.revokedAt) {
      throw await fail('unknown_device', 'this phone is not linked to Penny', 403);
    }
    if (this.d.now().getTime() > row.expiresAt.getTime()) {
      throw await fail('expired', 'this approval has expired', 410);
    }
    if (!this.hashStillMatches(row))
      throw await fail('changed', 'this action changed. check the new card.');
    const msg = new TextEncoder().encode(
      approvalSignMessage(row.approvalHash as string, row.challenge as string),
    );
    if (!verifyEd25519(device.publicKey, msg, Buffer.from(body.signature, 'base64url'))) {
      throw await fail('bad_signature', 'signature does not match this phone');
    }
    return this.finish(row, body);
  }

  /**
   * No-install path. POST /v1/approvals/:id/passkey: the WebAuthn assertion is
   * verified here, on the server: challenge matches and is unused (burned now),
   * origin and rpId match PUBLIC_BASE_URL, user verified (UV), signature against
   * the stored COSE key, sign count never goes backwards, not expired. Only then
   * the browser key's signed action is checked and relayed.
   */
  async approveWithPasskey(
    id: string,
    token: string | null,
    body: PasskeyApproveBody,
  ): Promise<{ status: string }> {
    const row = await this.precheck(id, token);
    const fail = async (code: string, msg: string, status: 403 | 410 | 422 = 422) => {
      await this.failAndReissue(row, code);
      return new ApprovalError(status, code, msg);
    };
    const pk = await this.d.passkeys.byCredentialId(body.assertion.id);
    if (!pk || pk.userId !== row.userId || pk.revokedAt) {
      throw await fail('unknown_passkey', 'this passkey is not linked to Penny', 403);
    }
    const base = new URL(this.d.publicBaseUrl);
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.assertion as never,
        expectedChallenge: row.challenge as string,
        expectedOrigin: base.origin,
        expectedRPID: base.hostname,
        credential: {
          id: pk.credentialId,
          publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')),
          counter: pk.signCount,
        },
        requireUserVerification: true,
      });
    } catch (e) {
      this.d.log.warn(
        { approvalId: row.id, err: (e as Error).message.slice(0, 120) },
        'passkey rejected',
      );
      throw await fail('bad_passkey', "the passkey check didn't pass");
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      throw await fail('bad_passkey', "the passkey check didn't pass");
    }
    const next = verification.authenticationInfo.newCounter;
    if (!(await this.d.passkeys.advanceCount(pk.id, pk.signCount, Math.max(next, pk.signCount)))) {
      throw await fail('bad_passkey', "the passkey check didn't pass");
    }
    if (this.d.now().getTime() > row.expiresAt.getTime()) {
      throw await fail('expired', 'this approval has expired', 410);
    }
    if (!this.hashStillMatches(row))
      throw await fail('changed', 'this action changed. check the new card.');
    // the browser key that signs the action must be the device this passkey belongs to
    const device = await this.d.users.deviceById(pk.deviceId);
    if (!device || device.revokedAt || device.userId !== row.userId) {
      throw await fail('unknown_device', 'this browser is not linked to Penny', 403);
    }
    return this.finish(row, body);
  }

  /** After the approve checks: the signed action itself (byte-for-byte), Guard again, relay. */
  private async finish(
    row: ApprovalRow,
    body: { signedDelegateAction?: string | undefined; planSignature?: string | undefined },
  ): Promise<{ status: string }> {
    const sub: { signedDelegateAction: string } | { planSignature: string } | null =
      body.signedDelegateAction
        ? { signedDelegateAction: body.signedDelegateAction }
        : body.planSignature
          ? { planSignature: body.planSignature }
          : null;
    if (!sub) {
      await this.failAndReissue(row, 'missing_action');
      throw new ApprovalError(400, 'wrong_body', 'the signed action is missing');
    }
    await this.updateCard(row.id, 'approving', 'approving…');
    try {
      return await this.submitChecked(row, sub);
    } catch (e) {
      if (
        e instanceof ApprovalError &&
        (e.code === 'delegate_mismatch' || e.code === 'bad_signature' || e.code === 'wrong_body')
      ) {
        await this.failAndReissue(row, e.code);
      }
      throw e;
    }
  }

  // ---------- freeze ----------

  /**
   * Freeze: revoke every device key and passkey for this user and expire every
   * open approval. The next approval fails with FROZEN_TEXT until "unfreeze".
   * On-chain key removal needs the user's own key (Penny never holds it), so the
   * chain side is left to the device; every Penny path refuses frozen keys.
   */
  async freeze(userId: string): Promise<{ devices: number; approvals: number }> {
    const now = this.d.now();
    const revoked = await this.d.users.freeze(userId, now);
    await this.d.passkeys.revokeForUser(userId, now);
    const open = await this.d.approvals.pendingForUser(userId);
    let n = 0;
    for (const row of open) {
      try {
        await this.d.approvals.transition(row.id, row.kind, 'pending', 'expired', 'frozen by user');
        await this.d.ledger.setStatusForApproval(row.id, 'released');
        if (row.kind === 'create_bot') await this.d.onBotDeclined?.(row.id);
        await this.updateCard(row.id, 'expired', 'frozen. nothing moved.');
        n += 1;
      } catch {
        /* already moved */
      }
    }
    await this.d.mood.on(userId, 'approval_expired');
    this.d.log.info({ userId, devices: revoked.length, approvals: n }, 'user froze penny');
    return { devices: revoked.length, approvals: n };
  }

  async unfreeze(userId: string): Promise<{ devices: number }> {
    const ids = await this.d.users.unfreeze(userId);
    await this.d.passkeys.restoreForDevices(ids);
    this.d.log.info({ userId, devices: ids.length }, 'user unfroze penny');
    return { devices: ids.length };
  }

  private async expire(row: ApprovalRow) {
    try {
      await this.d.approvals.transition(row.id, row.kind, 'pending', 'expired', 'ttl elapsed');
      await this.d.ledger.setStatusForApproval(row.id, 'released');
      if (row.kind === 'create_bot') await this.d.onBotDeclined?.(row.id);
      await this.d.mood.on(row.userId, 'approval_expired');
      await this.updateCard(row.id, 'expired', 'expired. tap for a new card.');
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
    await this.updateCard(id, 'declined', 'you said no. nothing moved.');
    return { status: 'cancelled' };
  }

  /**
   * @internal Signed-action relay without the approve-time checks (challenge,
   * approval hash, device or passkey). No HTTP route calls this any more: the
   * app uses signWithDevice and the link page approveWithPasskey. Kept for
   * service-level tests of the relay path.
   */
  async submit(
    id: string,
    token: string | null,
    body: { signedDelegateAction: string } | { planSignature: string },
  ): Promise<{ status: string }> {
    const row = await this.load(id, token, 'mutate', 'submit');
    if (row.status !== 'pending')
      throw new ApprovalError(409, 'not_pending', `approval is ${row.status}`);
    if (this.d.now().getTime() > row.expiresAt.getTime()) {
      if (row.kind === 'invest')
        throw this.requotedError(await this.requote(row, 'expired'), 'expired');
      await this.expire(row);
      throw new ApprovalError(410, 'expired', 'this approval has expired');
    }
    return this.submitChecked(row, body);
  }

  private submitChecked(
    row: ApprovalRow,
    body: { signedDelegateAction: string } | { planSignature: string },
  ): Promise<{ status: string }> {
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
      // Activate the bot BEFORE marking the approval settled. The other order left a
      // settled approval with no bot behind it whenever activation threw, and nothing
      // retried it. If activation fails, the approval fails honestly instead.
      try {
        await this.d.onBotApproved?.(row.id);
      } catch (e) {
        this.d.log.error({ approvalId: row.id, err: (e as Error).name }, 'bot activation failed');
        await this.d.approvals.transition(
          row.id,
          row.kind,
          'signed',
          'failed',
          'bot activation failed',
          {},
          { error: (e as Error).name },
        );
        await this.d.mood.on(row.userId, 'approval_failed');
        await this.updateCard(row.id, 'failed', 'that did not go through. nothing was changed.');
        return { status: 'failed' };
      }
      await this.d.approvals.transition(row.id, row.kind, 'signed', 'settled', 'bot activated');
      await this.d.mood.on(row.userId, 'bot_created');
      await this.updateCard(row.id, 'done', 'live');
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
      await this.updateCard(row.id, 'failed', 'that did not go through. nothing was changed.');
      return { status: 'failed' };
    }
    await this.d.approvals.transition(row.id, row.kind, 'signed', 'settled', 'write executed');
    await this.d.mood.on(row.userId, 'approval_settled');
    await this.updateCard(row.id, 'sent', 'done ✓');
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
    if (ctx.bot) {
      // this approval's own reservation also counts toward the bot's window; exclude it once
      const b = ctx.bot.spentLast24hMicros;
      ctx.bot.spentLast24hMicros = b > row.amountMicros ? b - row.amountMicros : 0n;
    }
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
      await this.updateCard(row.id, 'blocked', g.reasons[0] ?? 'Guard said no.');
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
    await this.updateCard(row.id, 'approving', 'sending…');
    let relay: Awaited<ReturnType<ChainPort['relay']>>;
    try {
      relay = await this.d.chain.relay(dto, body.signedDelegateAction);
    } catch (e) {
      // A throw here (RPC error, malformed deposit, crash mid-call) used to leave the
      // row `signed` with its ledger reservation held and nothing to sweep it.
      this.d.log.error({ approvalId: row.id, err: (e as Error).name }, 'relay threw');
      relay = { ok: false, reason: `RELAY_THREW: ${(e as Error).name}` };
    }
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
      await this.updateCard(row.id, 'failed', "didn't go through. nothing was sent.");
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
        this.d.log.info(
          { approvalId: row.id, ...this.investLinks(dep, relay.txHash) },
          'invest sent',
        );
        await this.updateCard(row.id, 'approving', SWAP_LINE.pending);
      }
    }
    try {
      return { status: await this.refreshStatus(row.id) };
    } catch (e) {
      // the deposit is already relayed; the poller picks the status up
      this.d.log.warn({ approvalId: row.id, err: (e as Error).name }, 'post-relay status failed');
      return { status: 'relayed' };
    }
  }

  private readonly swapStates = new Map<string, SwapState>();

  /** Explorer links for support and logs. Never shown on the card (plain-words rule). */
  private investLinks(depositAddress: string, txHash: string | null) {
    return {
      intentsExplorer: `https://explorer.near-intents.org/transactions/${depositAddress}`,
      ...(txHash ? { nearTx: `https://nearblocks.io/txns/${txHash}` } : {}),
    };
  }

  /** Before relaying an invest: quote still live and price within slippage, else re-card. */
  private async investPreflight(row: ApprovalRow, quoteId: string): Promise<void> {
    const q = this.d.invest?.get(quoteId);
    // same bar as Guard: under 15 s left is too close to send; re-card instead
    if (!q || q.expiresAt.getTime() - this.d.now().getTime() < QUOTE_MIN_REMAINING_MS) {
      throw this.requotedError(await this.requote(row, 'expired'), 'expired');
    }
    let r: Awaited<ReturnType<InvestPort['recheck']>>;
    try {
      // biome-ignore lint/style/noNonNullAssertion: q exists only when invest is wired
      r = await this.d.invest!.recheck(q);
    } catch (e) {
      this.d.log.warn({ approvalId: row.id, err: (e as Error).name }, 'invest recheck failed');
      throw new ApprovalError(502, 'price_check_failed', "Couldn't check the price. Try again.");
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
    if (s === 'settled' && row.kind === 'invest') {
      const events = await this.d.approvals.events(id);
      const dry = events.some((e) => e.reason === 'relayed (dry run)');
      const dep = investDepositAddress(row.actions as NearAction[]);
      if (!dry) {
        // A live swap only settles on the swap's own status, never on the deposit
        // alone. If the swap cannot be followed (invest off, no deposit address),
        // the deposit still landed: settle it rather than pinning the row at
        // `relayed` forever, which would hold the reservation open indefinitely.
        if (!this.d.invest || !dep) {
          this.d.log.warn(
            { approvalId: id, investWired: Boolean(this.d.invest), hasDeposit: Boolean(dep) },
            'invest settled on deposit; swap status unavailable',
          );
        } else {
          return this.refreshSwap(row, dep);
        }
      }
    }
    if (s === 'settled') {
      await this.d.approvals.transition(id, row.kind, 'relayed', 'settled', 'final on chain');
      await this.d.ledger.setStatusForApproval(id, 'settled');
      await this.d.mood.on(row.userId, 'approval_settled');
      const dry = (await this.d.approvals.events(id)).some((e) => e.reason === 'relayed (dry run)');
      await this.updateCard(id, 'sent', 'sent ✓', this.receiptOpts(row.txHash, dry));
      return 'settled';
    }
    await this.d.approvals.transition(id, row.kind, 'relayed', 'failed', 'chain reported failure');
    await this.d.ledger.setStatusForApproval(id, 'released');
    await this.d.mood.on(row.userId, 'approval_failed');
    await this.updateCard(id, 'failed', "didn't go through. nothing moved.");
    return 'failed';
  }

  /** Deposit landed on NEAR; follow the 1Click swap and update the card in place. */
  private async refreshSwap(row: ApprovalRow, dep: string): Promise<string> {
    // biome-ignore lint/style/noNonNullAssertion: caller checked invest is wired
    const view = await this.d.invest!.status(dep);
    const line =
      view.state === 'success' && view.amountOutDisplay
        ? `Done. You got ${view.amountOutDisplay}`
        : SWAP_LINE[view.state];
    this.d.log.info(
      { approvalId: row.id, swap: view.raw, ...this.investLinks(dep, row.txHash) },
      'invest status',
    );
    if (view.state === 'pending' || view.state === 'processing') {
      if (this.swapStates.get(row.id) !== view.state) {
        this.swapStates.set(row.id, view.state);
        await this.updateCard(row.id, 'approving', line);
      }
      return 'relayed';
    }
    this.swapStates.delete(row.id);
    if (view.state === 'success') {
      await this.d.approvals.transition(row.id, row.kind, 'relayed', 'settled', 'swap success');
      await this.d.ledger.setStatusForApproval(row.id, 'settled');
      await this.d.mood.on(row.userId, 'approval_settled');
      await this.updateCard(row.id, 'sent', line, this.receiptOpts(row.txHash, false));
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
    await this.updateCard(row.id, 'failed', line);
    return 'failed';
  }

  /** Sweep pending approvals past expiry. Run on an interval. */
  async expireDue(): Promise<number> {
    const due = await this.d.approvals.pendingExpiredBefore(this.d.now());
    for (const r of due) if (!isTerminal(r.status)) await this.expire(r);
    return due.length;
  }

  /**
   * Reconcile approvals stuck in `signed`. A row lands there after the device
   * signature verified and the CAS succeeded, so the money may or may not have
   * moved; nothing else sweeps this state. We release the reservation and fail the
   * row so the user's daily limit is not held hostage by a dead relay call. The
   * delegate action carries its own maxBlockHeight, so a late relay cannot double-spend.
   */
  async reconcileStuckSigned(olderThanMs = 15 * 60_000): Promise<number> {
    const cutoff = new Date(this.d.now().getTime() - olderThanMs);
    const rows = await this.d.approvals.signedOlderThan(cutoff);
    let fixed = 0;
    for (const row of rows) {
      try {
        await this.d.approvals.transition(
          row.id,
          row.kind,
          'signed',
          'failed',
          'relay never reported back; reservation released',
        );
        await this.d.ledger.setStatusForApproval(row.id, 'released');
        await this.d.mood.on(row.userId, 'approval_failed');
        await this.updateCard(row.id, 'failed', "didn't go through. nothing was sent.");
        fixed += 1;
      } catch (e) {
        this.d.log.warn(
          { approvalId: row.id, err: (e as Error).name },
          'stuck-signed reconcile failed',
        );
      }
    }
    return fixed;
  }
}
