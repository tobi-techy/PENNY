import type { ToolRisk } from '@penny/shared';

/**
 * The one place that decides which actions need Face ID (an approval card).
 * Never the model, never an agent's mood. Read-only tools never need it.
 * Anything new that writes outside Penny defaults to needing approval.
 *
 * Keys are tool ids from the registry plus the actions card buttons can take.
 */
export const APPROVAL_POLICY: Readonly<Record<string, boolean>> = {
  // read: look things up, nothing leaves Penny
  get_balances: false,
  get_portfolios: false,
  quote_invest: false,
  check_guard: false,
  propose_split: false, // a nudge card only; no money moves
  find_bills: false,
  list_bills: false,
  manage_commitments: false, // watch/pause local commitments; no money moves
  list_reminders: false,
  connect_app: false, // sends the user a link to connect; acts only after they do it themselves
  remember: false,
  recall: false,
  close_open_loop: false, // settles Penny's own follow-up list
  set_mood: false,
  read_github: false,
  read_x: false,
  draft_bot: false, // shows a draft; turning on a bot with write tools is create_bot below
  confirm_bot: false, // read-only bots only (BotService refuses others)
  // small changes inside Penny: info cards, Undo / Edit, no Face ID
  set_reminder: false,
  undo_reminder: false,
  draft_email: false,
  edit_draft: false,
  make_plan: false,
  close_bill: false, // mark your own saved bill paid / not mine
  cancel_reminder: false,
  send_setup_link: false, // texts the user their own setup link
  // money: always Face ID
  propose_send: true,
  propose_invest: true,
  propose_pay_bill: true,
  propose_errand: true,
  // acting in the user's name: always Face ID
  propose_write: true,
  send_email: true,
  post_x: true,
  github_comment: true,
  accept_invite: true,
  create_bot: true, // a bot with write or money tools
  grant_bot_write: true,
};

/** Card button actions that only change something small inside Penny. */
const BUTTON_POLICY: Readonly<Record<string, boolean>> = {
  open: false,
  edit: false,
  undo: false,
  pick: false,
  decline: false,
  renew: false,
  freeze: false, // freezing only takes power away; it never needs Face ID
  send: true,
  approve: true,
  unfreeze: true, // gives power back: Face ID on the card, never a plain press
};

export type PolicyAction =
  | { tool: string; risk?: ToolRisk }
  | { button: string }
  | { approvalKind: string };

/**
 * Does this action need Face ID? Deterministic; defaults to yes for anything
 * not in the table unless it is a read-only tool.
 */
export function needsApproval(action: PolicyAction): boolean {
  if ('button' in action) return BUTTON_POLICY[action.button] ?? true;
  if ('approvalKind' in action) return true; // every Approval record is a Face ID card
  const known = APPROVAL_POLICY[action.tool];
  if (known !== undefined) {
    // a tool can never be downgraded below its declared risk
    if (action.risk && action.risk !== 'read') return true;
    return known;
  }
  return action.risk !== 'read';
}
