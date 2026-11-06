import type { ApprovalKind, ApprovalStatus } from '@penny/shared';

/**
 * pending -> signed -> relayed -> settled | failed
 * pending -> expired | cancelled
 * signed  -> failed  (relay rejected / guard re-check failed)
 * Terminal: settled, failed, expired, cancelled. Nothing leaves a terminal state.
 */
const TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ['signed', 'expired', 'cancelled'],
  signed: ['relayed', 'failed'],
  relayed: ['settled', 'failed'],
  settled: [],
  failed: [],
  expired: [],
  cancelled: [],
};

/**
 * create_bot approvals have no chain step: signed (device signature verified)
 * goes straight to settled. Money approvals can never skip the relay.
 */
const NO_CHAIN_KINDS: readonly ApprovalKind[] = ['create_bot', 'write'];

export function canTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
  kind: ApprovalKind = 'send',
): boolean {
  if (NO_CHAIN_KINDS.includes(kind) && from === 'signed' && to === 'settled') return true;
  if (NO_CHAIN_KINDS.includes(kind) && to === 'relayed') return false;
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(s: ApprovalStatus): boolean {
  return TRANSITIONS[s].length === 0;
}

export class TransitionError extends Error {
  override name = 'TransitionError';
  constructor(
    readonly from: ApprovalStatus,
    readonly to: ApprovalStatus,
  ) {
    super(`illegal approval transition ${from} -> ${to}`);
  }
}

export function assertTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
  kind: ApprovalKind = 'send',
): void {
  if (!canTransition(from, to, kind)) throw new TransitionError(from, to);
}

export type StatusStep = { label: string; state: 'todo' | 'active' | 'done' | 'failed' };

/** Step list for the live card. */
export function stepsFor(status: ApprovalStatus, kind: ApprovalKind = 'send'): StatusStep[] {
  const labels =
    kind === 'write'
      ? ['Approved with Face ID', 'Done in the app', 'Finished']
      : kind === 'create_bot'
        ? ['Approved with Face ID', 'Bot switched on', 'Finished']
        : ['Approved with Face ID', 'Sent to NEAR', 'Settled'];
  const doneCount: Record<ApprovalStatus, number> = {
    pending: 0,
    signed: 1,
    relayed: 2,
    settled: 3,
    failed: -1,
    expired: -2,
    cancelled: -2,
  };
  const n = doneCount[status];
  if (n === -2) return labels.map((label) => ({ label, state: 'todo' }));
  if (n === -1) {
    return [
      { label: labels[0] as string, state: 'done' },
      { label: labels[1] as string, state: 'failed' },
      { label: labels[2] as string, state: 'todo' },
    ];
  }
  return labels.map((label, i) => ({
    label,
    state: i < n ? 'done' : i === n ? 'active' : 'todo',
  }));
}
