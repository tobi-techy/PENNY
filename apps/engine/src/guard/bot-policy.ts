import { type CreateBotPlan, compareDecimal, type ToolRisk } from '@penny/shared';
import type { GuardDecision, GuardPolicy } from './policy.ts';

/**
 * Guard rules for creating a bot. Pure.
 *
 * - every tool must exist in the registry
 * - built-in-only tools (internal crew plumbing) can't be granted
 * - money tools only with canMoveMoney + perTxCap + dailyCap, caps <= user's own limits
 * - caps without money tools are rejected (no dormant spend rights)
 * - slug can't shadow a built-in or an existing bot of the user's
 * - risk = highest tool risk. read -> plain confirm. write|money -> Face ID approval card.
 */

export type ToolInfo = { risk: ToolRisk; builtInOnly?: boolean };

export type BotCreationResult = {
  decision: GuardDecision;
  reasons: string[];
  risk: ToolRisk;
  confirmation: 'plain_confirm' | 'face_id';
};

const RISK_ORDER: Record<ToolRisk, number> = { read: 0, write: 1, money: 2 };

export function maxRisk(risks: readonly ToolRisk[]): ToolRisk {
  let r: ToolRisk = 'read';
  for (const x of risks) if (RISK_ORDER[x] > RISK_ORDER[r]) r = x;
  return r;
}

export function evaluateBotCreation(
  plan: CreateBotPlan,
  tools: ReadonlyMap<string, ToolInfo>,
  takenSlugs: ReadonlySet<string>,
  userPolicy: GuardPolicy,
): BotCreationResult {
  const block: string[] = [];
  const risks: ToolRisk[] = [];

  if (takenSlugs.has(plan.slug)) {
    block.push(`There's already a bot called "${plan.slug}". Pick another name.`);
  }
  const uniq = new Set(plan.toolIds);
  if (uniq.size !== plan.toolIds.length) block.push('The tool list has duplicates.');

  for (const id of uniq) {
    const t = tools.get(id);
    if (!t) {
      block.push(`I don't have a tool called "${id}".`);
      continue;
    }
    if (t.builtInOnly) {
      block.push(`"${id}" is reserved for the core crew.`);
      continue;
    }
    risks.push(t.risk);
  }

  const risk = maxRisk(risks);
  const p = plan.permissions;
  const hasMoneyTool = risks.includes('money');

  if (hasMoneyTool) {
    if (!p.canMoveMoney || !p.perTxCap || !p.dailyCap) {
      block.push(
        'Custom bots never get money tools unless you give them a spending cap (per payment and per day).',
      );
    } else {
      if (compareDecimal(p.perTxCap, userPolicy.perTxUsd) > 0)
        block.push(
          `The bot's per-payment cap can't be higher than yours ($${userPolicy.perTxUsd}).`,
        );
      if (compareDecimal(p.dailyCap, userPolicy.dailyUsd) > 0)
        block.push(`The bot's daily cap can't be higher than yours ($${userPolicy.dailyUsd}).`);
      if (compareDecimal(p.perTxCap, p.dailyCap) > 0)
        block.push("The per-payment cap can't be bigger than the daily cap.");
      if (compareDecimal(p.perTxCap, '0') <= 0 || compareDecimal(p.dailyCap, '0') <= 0)
        block.push('Caps have to be more than zero.');
    }
  } else if (p.canMoveMoney || p.perTxCap || p.dailyCap) {
    block.push("This bot has no money tools, so it shouldn't carry money permissions.");
  }

  const confirmation = risk === 'read' ? 'plain_confirm' : 'face_id';
  if (block.length > 0) return { decision: 'block', reasons: block, risk, confirmation };

  const reasons =
    confirmation === 'plain_confirm'
      ? ['Read-only bot. A quick yes from you and it goes live.']
      : [
          risk === 'money'
            ? 'This bot can move money within its caps, so it needs your Face ID.'
            : 'This bot can act for you (post, write, comment), so it needs your Face ID.',
        ];
  return { decision: 'allow_with_approval', reasons, risk, confirmation };
}
