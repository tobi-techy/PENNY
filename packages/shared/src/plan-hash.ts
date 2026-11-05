import { canonicalize } from './canonical.ts';
import { sha256Base64Url } from './encoding.ts';
import type { IntentPlan, NearAction } from './schemas.ts';

/**
 * planHash = base64url(sha256(canonicalJSON({ plan, actions })))   (ARCHITECTURE.md)
 * The object shape { "actions": [...], "plan": {...} } is fixed; Swift must match.
 */
export function planHashInput(plan: IntentPlan, actions: readonly NearAction[]): string {
  return canonicalize({ plan, actions });
}

export function planHash(plan: IntentPlan, actions: readonly NearAction[]): string {
  return sha256Base64Url(planHashInput(plan, actions));
}
