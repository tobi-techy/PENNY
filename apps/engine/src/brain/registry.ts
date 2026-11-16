import type { ToolRisk } from '@penny/shared';
import { type Tool, tool } from 'ai';
import type { z } from 'zod';
import type { ApprovalService } from '../approvals/service.ts';
import type { BillsService } from '../bills/service.ts';
import type { ConnectorPort } from '../connectors/composio.ts';
import type { ToolInfo } from '../guard/bot-policy.ts';
import type { OnboardingService } from '../onboarding.ts';
import type { SpaceRef } from '../ports/messaging.ts';
import type { BotRow } from '../repo/bots.ts';
import type { MemoryService } from './memory.ts';
import type { MoodService } from './mood.ts';

/**
 * Read-only market data. Real adapter: market/real-market.ts (NEAR RPC balances,
 * 1Click prices with a CoinGecko fallback). Invest quotes live in market/invest.ts.
 */
export interface MarketPort {
  getBalances(accountId: string): Promise<{ asset: string; amount: string }[]>;
  /** What Invest can buy (ETH, SOL, NEAR) with a live USD price when available. */
  getPortfolios(): Promise<{ id: string; name: string; blurb: string; priceUsd?: string }[]>;
  /** micro-USD per NEAR, for sizing NEAR sends in Guard. Throws when no price is available. */
  nearUsdPriceMicros?(): Promise<bigint>;
}

/** Bot-creation hooks the registry exposes to Penny without a circular import. */
export interface BotOps {
  draft(userId: string, plan: unknown, space: SpaceRef): Promise<unknown>;
  confirm(userId: string, slug: string): Promise<unknown>;
  /** A running bot asks its user for one more tool (Face ID card, then a grant). */
  requestTool(
    userId: string,
    bot: BotRow,
    toolId: string,
    why: string,
    space: SpaceRef,
  ): Promise<unknown>;
}

export type ToolContext = {
  userId: string;
  accountId: string | null;
  bot: BotRow;
  space: SpaceRef;
  approvals: ApprovalService;
  connectors?: ConnectorPort;
  bills?: BillsService;
  /** Recurring obligations Penny watches between bills. */
  commitments?: import('../commitments/service.ts').CommitmentsService;
  onboarding?: OnboardingService;
  memory: MemoryService;
  mood: MoodService;
  /** Open loops: the live turn can settle one so no follow-up repeats it. */
  followup?: {
    close(userId: string, id: string, status: 'done' | 'dropped'): Promise<boolean>;
  };
  market: MarketPort;
  /** Finance's read-only spend summary ("what did I spend this week?"). */
  finance?: import('../finance/summary.ts').FinancePort;
  /** Adding dollars from another chain (NEAR Intents deposit address). */
  funding?: {
    chains(): Promise<string[]>;
    start(input: {
      userId: string;
      space: SpaceRef;
      amountUsd: string;
      chain: import('../market/funding.ts').FundChain;
    }): Promise<unknown>;
  };
  botOps: BotOps;
  /** Info-card jobs (reminders, drafts). Absent in some tests. */
  everyday?: {
    cards: import('../cards/sender.ts').CardSender;
    reminders: import('../repo/cards.ts').RemindersRepo;
    now: () => Date;
  };
};

export type ToolDef<I = unknown> = {
  id: string;
  description: string;
  risk: ToolRisk;
  /** core-crew plumbing (draft_bot, confirm_bot); never grantable to custom bots */
  builtInOnly?: boolean;
  /**
   * A grant, not something to call. Granting it loads that app's real tools into
   * the bot's turn (see connectors/toolkits.ts), so it is never offered to the
   * model as a callable tool.
   */
  capability?: boolean;
  input: z.ZodType<I>;
  execute: (ctx: ToolContext, input: I) => Promise<unknown>;
};

export class ToolRegistry {
  private tools = new Map<string, ToolDef<unknown>>();

  register<I>(def: ToolDef<I>): this {
    if (this.tools.has(def.id)) throw new Error(`duplicate tool ${def.id}`);
    this.tools.set(def.id, def as unknown as ToolDef<unknown>);
    return this;
  }

  get(id: string): ToolDef<unknown> | undefined {
    return this.tools.get(id);
  }

  list(): ToolDef<unknown>[] {
    return [...this.tools.values()];
  }

  info(): Map<string, ToolInfo> {
    const m = new Map<string, ToolInfo>();
    for (const t of this.tools.values())
      m.set(t.id, { risk: t.risk, ...(t.builtInOnly ? { builtInOnly: true } : {}) });
    return m;
  }

  /**
   * Tools a bot may actually call right now. Enforced here, not by prompt:
   * - only ids on the bot row that exist in the registry
   * - builtInOnly tools only for built-in bots
   * - money tools for custom bots only with canMoveMoney + both caps
   */
  allowedFor(bot: BotRow): ToolDef<unknown>[] {
    const out: ToolDef<unknown>[] = [];
    for (const id of new Set(bot.toolIds)) {
      const t = this.tools.get(id);
      if (!t) continue;
      if (t.builtInOnly && !bot.builtIn) continue;
      if (t.risk === 'money' && !bot.builtIn) {
        const p = bot.permissions;
        if (!p.canMoveMoney || !p.perTxCap || !p.dailyCap) continue;
      }
      out.push(t);
    }
    return out;
  }

  /** Vercel AI SDK tool set for this bot. Inputs are zod-validated by the SDK and again here. */
  toAiTools(ctx: ToolContext): Record<string, Tool> {
    const set: Record<string, Tool> = {};
    for (const t of this.allowedFor(ctx.bot)) {
      // A capability is a grant of an app's tools, not a tool to call: the real
      // tools come from the connector for exactly this bot's grants.
      if (t.capability) continue;
      set[t.id] = tool({
        description: t.description,
        inputSchema: t.input,
        execute: async (raw: unknown) => {
          const parsed = t.input.safeParse(raw);
          if (!parsed.success)
            return { ok: false, error: 'invalid input', issues: parsed.error.issues.length };
          try {
            return await t.execute(ctx, parsed.data);
          } catch (e) {
            return { ok: false, error: (e as Error).name };
          }
        },
      }) as Tool;
    }
    return set;
  }
}
