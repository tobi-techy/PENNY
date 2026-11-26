import { type Card, WritePlan } from '@penny/shared';
import {
  AFTER_EXPIRY_BUTTON_MS,
  ApprovalError,
  type ApprovalService,
} from '../approvals/service.ts';
import { sha256Hex } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import type { BotsRepo } from '../repo/bots.ts';
import type { CardRow, CardsRepo, RemindersRepo } from '../repo/cards.ts';
import { needsApproval } from './policy.ts';
import { type CardSender, toCardDto } from './sender.ts';

export type PressResult = {
  card: Card;
  /** For Edit: the text the user can change. */
  editable?: { label: string; value: string };
  /** For Open: where to go. */
  openUrl?: string;
  /** For Get a new card: the new approval (its card arrives in the thread). */
  renewedApprovalId?: string | null;
};

/**
 * Card buttons (POST /v1/cards/by-token/:token/press). Small changes (Undo,
 * Edit, Pick, Open) happen right away with no Face ID. A button that sends,
 * pays or posts turns the card into an approval card first; the change itself
 * only happens after Face ID through the approve endpoints.
 */
export class CardActions {
  constructor(
    private readonly d: {
      cards: CardsRepo;
      sender: CardSender;
      approvals: ApprovalService;
      reminders: RemindersRepo;
      bots: BotsRepo;
      /** Turn a found bill into a pay_bill approval (Guard runs inside). */
      payBill?: (input: {
        userId: string;
        billId: string;
        space: NonNullable<CardRow['space']>;
        card: CardRow;
      }) => Promise<{ decision: string; reasons?: string[] }>;
      /** Mark a saved bill not mine, without touching money. */
      dismissBill?: (userId: string, billId: string) => Promise<{ ok: boolean; error?: string }>;
      now: () => Date;
      log: Logger;
    },
  ) {}

  private async load(token: string, graceMs = 0): Promise<CardRow> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    const row = await this.d.cards.byTokenHash(sha256Hex(token));
    if (!row || this.d.now().getTime() > row.tokenExpiresAt.getTime() + graceMs) {
      throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    }
    return row;
  }

  async press(token: string, buttonId: string, confirm = false): Promise<PressResult> {
    // Not me (freeze) and Get a new card show on blocked/expired cards: allow them after expiry
    const row = await this.load(token, AFTER_EXPIRY_BUTTON_MS);
    const button = row.buttons.find((b) => b.id === buttonId);
    if (!button) throw new ApprovalError(404, 'no_button', 'that button is gone');
    const late = this.d.now().getTime() > row.tokenExpiresAt.getTime();
    if (late && button.action !== 'freeze' && button.action !== 'renew') {
      throw new ApprovalError(401, 'unauthorized', 'unauthorized');
    }
    const payload = row.payload ?? {};

    // Policy decides, not the card: approve happens only through Face ID endpoints.
    if (button.action === 'approve' || button.action === 'unfreeze') {
      throw new ApprovalError(409, 'use_face_id', 'approve with Face ID');
    }
    if (button.action === 'pay') {
      const billId = typeof payload.billId === 'string' ? payload.billId : null;
      if (!billId || !row.space || !this.d.payBill) {
        throw new ApprovalError(409, 'not_payable', 'nothing to pay here');
      }
      // Same card, same URL: the found bill becomes a Face ID approval in place.
      if (!(await this.d.cards.claimForApproval(row.id))) {
        throw new ApprovalError(409, 'already_paid', 'this bill is already waiting for Face ID');
      }
      let r: { decision: string; reasons?: string[] };
      try {
        r = await this.d.payBill({
          userId: row.userId,
          billId,
          space: row.space,
          card: row,
        });
      } catch (e) {
        await this.d.cards.update(row.id, { kind: 'info' });
        throw e;
      }
      if (r.decision !== 'allow_with_approval') {
        await this.d.cards.update(row.id, { kind: 'info' });
        throw new ApprovalError(409, 'blocked', r.reasons?.[0] ?? "i can't pay this bill yet");
      }
      const fresh = await this.d.cards.get(row.id);
      return { card: toCardDto(fresh ?? row) };
    }
    if (button.action === 'dismiss') {
      const billId = typeof payload.billId === 'string' ? payload.billId : null;
      if (!billId || !this.d.dismissBill) {
        throw new ApprovalError(409, 'not_dismissable', 'nothing to dismiss here');
      }
      const r = await this.d.dismissBill(row.userId, billId);
      if (!r.ok) {
        throw new ApprovalError(409, 'could_not_dismiss', r.error ?? "couldn't dismiss that bill");
      }
      const card = await this.d.sender.update(
        row.id,
        {
          state: 'done',
          type: 'done',
          title: 'Bill dismissed',
          buttons: [],
        },
        { subcaption: 'dismissed.' },
      );
      return { card: card ?? toCardDto(row) };
    }
    if (needsApproval({ button: button.action })) {
      // send: the draft becomes an approval card (same card, same URL)
      const plan = WritePlan.safeParse(payload.writePlan);
      if (!plan.success || row.kind !== 'info' || !row.space) {
        throw new ApprovalError(409, 'not_sendable', 'nothing to send here');
      }
      // one press wins: claim the draft (info -> approval) before creating anything
      if (!(await this.d.cards.claimForApproval(row.id))) {
        throw new ApprovalError(409, 'already_sent', 'this draft is already waiting for Face ID');
      }
      // seal what is in the card now (an edit may have landed between our read and the claim)
      const claimed = await this.d.cards.get(row.id);
      const sealed = WritePlan.safeParse(claimed?.payload?.writePlan);
      if (!sealed.success) {
        await this.d.cards.update(row.id, { kind: 'info' });
        throw new ApprovalError(409, 'not_sendable', 'nothing to send here');
      }
      const botId = typeof payload.botId === 'string' ? payload.botId : null;
      const bot = botId ? await this.d.bots.byId(botId) : null;
      const r = await this.d.approvals
        .createWriteApproval({
          userId: row.userId,
          bot,
          plan: sealed.data,
          space: row.space,
          fromCard: { id: row.id, tokenHash: row.tokenHash },
        })
        .catch(async (e: unknown) => {
          await this.d.cards.update(row.id, { kind: 'info' });
          throw e;
        });
      if (r.decision !== 'allow_with_approval') {
        await this.d.cards.update(row.id, { kind: 'info' });
        throw new ApprovalError(409, 'blocked', r.reasons[0] ?? "can't send that");
      }
      const fresh = await this.d.cards.get(row.id);
      return { card: toCardDto(fresh ?? row) };
    }

    switch (button.action) {
      case 'undo': {
        const id = typeof payload.reminderId === 'string' ? payload.reminderId : null;
        if (!id || !(await this.d.reminders.undo(id))) {
          throw new ApprovalError(409, 'too_late', 'that already happened');
        }
        const card = await this.d.sender.update(row.id, {
          state: 'undone',
          title: 'Reminder removed',
          buttons: [],
        });
        return { card: card ?? toCardDto(row) };
      }
      case 'edit': {
        const plan = WritePlan.safeParse(payload.writePlan);
        const body = plan.success ? String(plan.data.arguments.body ?? '') : '';
        return { card: toCardDto(row), editable: { label: 'Message', value: body } };
      }
      case 'open':
        return { card: toCardDto(row), ...(button.value ? { openUrl: button.value } : {}) };
      case 'pick': {
        const card = await this.d.sender.update(row.id, {
          state: 'done',
          lines: [{ label: 'You picked', value: (button.value ?? button.label).slice(0, 120) }],
          buttons: [],
        });
        return { card: card ?? toCardDto(row) };
      }
      case 'decline': {
        if (row.approvalId) await this.d.approvals.decline(row.approvalId, token);
        const fresh = await this.d.cards.get(row.id);
        return { card: toCardDto(fresh ?? row) };
      }
      case 'renew': {
        const r = await this.d.approvals.renewByToken(token);
        return { card: toCardDto(row), renewedApprovalId: r.approvalId };
      }
      case 'freeze': {
        // freezing switches off every key: ask first ("Freeze everything?"), then do it
        if (!confirm) throw new ApprovalError(409, 'confirm_freeze', 'confirm to freeze');
        await this.d.approvals.freeze(row.userId);
        if (row.space) {
          await this.d.sender.update(row.id, { buttons: [] }).catch(() => null);
        }
        const fresh = await this.d.cards.get(row.id);
        return { card: toCardDto(fresh ?? row) };
      }
      default:
        throw new ApprovalError(400, 'unknown_action', 'unknown button');
    }
  }

  /** Edit a draft's text. No Face ID: nothing is sent until Send + Face ID. */
  async editDraft(token: string, text: string): Promise<Card> {
    const row = await this.load(token);
    const payload = row.payload ?? {};
    const plan = WritePlan.safeParse(payload.writePlan);
    if (!plan.success || row.kind !== 'info')
      throw new ApprovalError(409, 'not_editable', 'nothing to edit');
    const next = { ...plan.data, arguments: { ...plan.data.arguments, body: text.slice(0, 5000) } };
    // atomic: once Send turned the draft into an approval, the text is sealed
    if (!(await this.d.cards.updateDraftPayload(row.id, { ...payload, writePlan: next }))) {
      throw new ApprovalError(409, 'not_editable', 'this draft is already waiting for Face ID');
    }
    const lines = row.lines.map((l, i) =>
      i === row.lines.length - 1 && !l.label ? { value: text.slice(0, 120) || '(empty)' } : l,
    );
    const card = await this.d.sender.update(row.id, { lines });
    return card ?? toCardDto(row);
  }
}
