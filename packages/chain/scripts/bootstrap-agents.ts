/**
 * DRY plan printer for agent sub-accounts (invest/guard/mail/finance/errand.<app>).
 * Never signs, never sends. Pass PUBLIC keys only, e.g.
 *   AGENT_INVEST_PUBKEY=ed25519:... bun run scripts/bootstrap-agents.ts
 */
import { AGENT_NAMES, type AgentName, planAgentAccounts } from '../src/near/accounts.ts';

const app = process.env.NEAR_APP_ACCOUNT_ID ?? 'penny.near';
const keys: Partial<Record<AgentName, string>> = {};
for (const n of AGENT_NAMES) {
  const v = process.env[`AGENT_${n.toUpperCase()}_PUBKEY`];
  if (v) keys[n] = v;
}
const plan = planAgentAccounts(app, keys);
console.log(`DRY PLAN — signer ${app}. Nothing is sent.\n`);
for (const p of plan) {
  console.log(
    `${p.accountId}\n  signer: ${p.signerId}\n  actions: CreateAccount, Transfer(${p.initialBalanceNear} NEAR), AddKey(${p.fullAccessKey}, FullAccess)\n  ${p.note}\n`,
  );
}
console.log(
  'To execute later: one tx per agent signed by the app key, after Tobi says go (DRY_RUN=0, PENNY_ENV=mainnet).',
);
