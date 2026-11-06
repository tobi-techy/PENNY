import type { ToolRisk } from '@penny/shared';
import { type Tool, tool } from 'ai';
import type { z } from 'zod';
import type { ApprovalService } from '../approvals/service.ts';
import type { ConnectorPort } from '../connectors/composio.ts';
import type { ToolInfo } from '../guard/bot-policy.ts';
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
}

export type ToolContext = {
  userId: string;
  accountId: string | null;
  bot: BotRow;
  space: SpaceRef;
  approvals: ApprovalService;
  connectors?: ConnectorPort;
  memory: MemoryService;
  mood: MoodService;
  market: MarketPort;
  botOps: BotOps;
};

export type ToolDef<I = unknown> = {
  id: string;
  description: string;
  risk: ToolRisk;
  /** core-crew plumbing (draft_bot, confirm_bot); never grantable to custom bots */
  builtInOnly?: boolean;
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
