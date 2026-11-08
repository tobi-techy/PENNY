import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CreateBotPlan } from '@penny/shared';
import type { ApprovalService } from '../approvals/service.ts';
import { evaluateBotCreation } from '../guard/bot-policy.ts';
import { newId } from '../lib/ids.ts';
import type { SpaceRef } from '../ports/messaging.ts';
import type { BotRow, BotsRepo } from '../repo/bots.ts';
import type { GuardDecisionsRepo } from '../repo/infra.ts';
import type { UsersRepo } from '../repo/users.ts';
import type { MoodService } from './mood.ts';
import type { ToolRegistry } from './registry.ts';

export const MONEY_RULE_LINE = 'Mood never overrides money rules.';

/** Built-in crew: data seeded into `bots`, not hardcoded behaviour. */
export const BUILT_IN_BOTS: { slug: string; name: string; toolIds: string[] }[] = [
  {
    slug: 'penny',
    name: 'Penny',
    toolIds: [
      'get_balances',
      'check_guard',
      'propose_send',
      'propose_split',
      'remember',
      'recall',
      'set_mood',
      'draft_bot',
      'confirm_bot',
      'connect_app',
      'propose_write',
      'find_bills',
      'list_bills',
      'close_bill',
      'remind_me',
      'list_reminders',
      'cancel_reminder',
    ],
  },
  {
    slug: 'invest',
    name: 'Invest',
    toolIds: [
      'get_balances',
      'get_portfolios',
      'quote_invest',
      'check_guard',
      'propose_invest',
      'remember',
      'recall',
    ],
  },
  { slug: 'guard', name: 'Guard', toolIds: ['check_guard', 'recall'] },
  {
    slug: 'mail',
    name: 'Mail',
    toolIds: [
      'find_bills',
      'propose_pay_bill',
      'connect_app',
      'propose_write',
      'remember',
      'recall',
      'list_bills',
      'close_bill',
      'remind_me',
      'list_reminders',
      'cancel_reminder',
    ],
  },
  {
    slug: 'finance',
    name: 'Finance',
    toolIds: [
      'get_balances',
      'propose_split',
      'propose_send',
      'propose_pay_bill',
      'check_guard',
      'connect_app',
      'find_bills',
      'remember',
      'recall',
      'list_bills',
      'close_bill',
      'remind_me',
      'list_reminders',
    ],
  },
  {
    slug: 'errand',
    name: 'Errand',
    toolIds: [
      'propose_errand',
      'check_guard',
      'connect_app',
      'propose_write',
      'remember',
      'recall',
      'remind_me',
      'list_reminders',
      'cancel_reminder',
    ],
  },
];

export function withMoneyRule(soul: string): string {
  return soul.toLowerCase().includes(MONEY_RULE_LINE.toLowerCase())
    ? soul
    : `${soul.trimEnd()}\n\n${MONEY_RULE_LINE}\n`;
}

export type DraftResult =
  | { ok: false; reasons: string[] }
  | { ok: true; botId: string; slug: string; status: 'pending_confirm'; next: 'say_yes' }
  | {
      ok: true;
      botId: string;
      slug: string;
      status: 'pending_approval';
      next: 'face_id_card_sent';
      approvalId: string;
    };

export type BotServiceDeps = {
  bots: BotsRepo;
  users: UsersRepo;
  guardDecisions: GuardDecisionsRepo;
  registry: ToolRegistry;
  mood: MoodService;
  approvals: () => ApprovalService; // late-bound (approvals calls back into us)
};

export class BotService {
  constructor(private readonly d: BotServiceDeps) {}

  async seedBuiltIns(soulsDir: string): Promise<BotRow[]> {
    const out: BotRow[] = [];
    for (const b of BUILT_IN_BOTS) {
      for (const id of b.toolIds)
        if (!this.d.registry.get(id)) throw new Error(`seed: unknown tool ${id}`);
      let soul = `# ${b.name}\n`;
      try {
        soul = await readFile(join(soulsDir, `${b.slug}.md`), 'utf8');
      } catch {
        /* soul file optional in tests */
      }
      out.push(
        await this.d.bots.upsertBuiltIn({
          slug: b.slug,
          name: b.name,
          soulMd: withMoneyRule(soul),
          toolIds: b.toolIds,
          permissions: {
            canMoveMoney: b.toolIds.some((t) => this.d.registry.get(t)?.risk === 'money'),
          },
        }),
      );
    }
    return out;
  }

  /** create_bot IntentPlan from Penny. Guard decides; risk decides plain confirm vs Face ID. */
  async draft(userId: string, rawPlan: unknown, space: SpaceRef): Promise<DraftResult> {
    const parsed = CreateBotPlan.safeParse(rawPlan);
    if (!parsed.success)
      return {
        ok: false,
        reasons: ["That bot draft wasn't valid. Let's try describing it again."],
      };
    const plan = { ...parsed.data, soulMd: withMoneyRule(parsed.data.soulMd) };
    const policy = await this.d.users.policy(userId);
    const taken = await this.d.bots.allSlugsFor(userId);
    const g = evaluateBotCreation(plan, this.d.registry.info(), taken, policy);
    await this.d.guardDecisions.record({
      userId,
      approvalId: null,
      plan,
      decision: g.decision,
      reasons: g.reasons,
    });
    if (g.decision !== 'allow_with_approval') {
      await this.d.mood.on(userId, 'guard_blocked', 'guard');
      return { ok: false, reasons: g.reasons };
    }

    const botId = newId('bot');
    const base = {
      id: botId,
      userId,
      slug: plan.slug,
      name: plan.name,
      soulMd: plan.soulMd,
      toolIds: plan.toolIds,
      permissions: plan.permissions,
      builtIn: false,
    };

    if (g.confirmation === 'plain_confirm') {
      await this.d.bots.insert({ ...base, status: 'pending_confirm' });
      return { ok: true, botId, slug: plan.slug, status: 'pending_confirm', next: 'say_yes' };
    }

    const riskLabel =
      g.risk === 'money' ? 'act for you and move money within caps' : 'act for you (post / write)';
    const card = await this.d.approvals().createBotApproval({ userId, plan, space, riskLabel });
    if (!card)
      return {
        ok: false,
        reasons: [
          'Set up approvals first (tap the setup link Penny sent you), then I can make this bot.',
        ],
      };
    await this.d.bots.insert({ ...base, status: 'pending_approval', approvalId: card.approvalId });
    return {
      ok: true,
      botId,
      slug: plan.slug,
      status: 'pending_approval',
      next: 'face_id_card_sent',
      approvalId: card.approvalId,
    };
  }

  /** Plain "yes" path. Only for bots whose tools are all read-only (re-checked). */
  async confirm(userId: string, slug: string): Promise<{ ok: boolean; reason?: string }> {
    const mine = (await this.d.bots.allSlugsFor(userId)).has(slug);
    if (!mine) return { ok: false, reason: 'no such bot' };
    const rows = await this.pendingConfirm(userId, slug);
    if (!rows) return { ok: false, reason: 'nothing waiting for a yes' };
    const risky = rows.toolIds.some((id) => this.d.registry.get(id)?.risk !== 'read');
    if (risky || rows.permissions.canMoveMoney)
      return { ok: false, reason: 'this bot needs Face ID, not a plain yes' };
    const r = await this.d.bots.setStatus(rows.id, 'pending_confirm', 'active');
    if (!r) return { ok: false, reason: 'already handled' };
    await this.d.mood.on(userId, 'bot_created');
    return { ok: true };
  }

  private async pendingConfirm(userId: string, slug: string): Promise<BotRow | null> {
    const row = await this.d.bots.byOwnerSlug(userId, slug);
    return row && row.status === 'pending_confirm' ? row : null;
  }

  async onApprovalSettled(approvalId: string): Promise<void> {
    const bot = await this.d.bots.byApproval(approvalId);
    if (bot) await this.d.bots.setStatus(bot.id, 'pending_approval', 'active');
  }

  async onApprovalDeclined(approvalId: string): Promise<void> {
    const bot = await this.d.bots.byApproval(approvalId);
    if (bot) await this.d.bots.setStatus(bot.id, 'pending_approval', 'archived');
  }
}
