import type { BadgeCheck, BadgeVerdict } from './types.ts';

/**
 * Collapse the registry's individual checks into one verdict.
 * - revoked: on-chain status is revoked, or the check says the agent is inactive
 * - unknown: the registry has no agent for this badge
 * - verified: the badge is valid
 * - invalid: the badge exists but does not satisfy the badge checks
 */
export function verdictOf(check: BadgeCheck): BadgeVerdict {
  const status = check.status?.toLowerCase();
  if (status === 'revoked' || check.checks.status_active === false) return 'revoked';
  if (check.checks.on_chain_agent_found === false) return 'unknown';
  if (check.badgeValid) return 'verified';
  return 'invalid';
}
