# Deep Concordium integration: plan

Status as of 13 Nov 2026. Supersedes the engine sections of `docs/CONCORDIUM.md` where they disagree.

## Where we actually are

Done and verified on testnet:

- Owner account `3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT`, headless identity, faucet funded.
- Four agents registered on canonical CIS-8004 `<12802,0>`: Penny 1169, Guard 1170, Invest 1171, Mail 1172.
- Four Agent Cards built from the MCP builders, pinned, and previously verified `badge_valid: true` with zero issues.
- `packages/concordium`: typed client, verdict mapping, 22 tests.
- `verify_agent` tool wired into the engine, off by default, 7 tests.
- Passport routes at `/agents`, `/agents/:slug`, `/agents/:slug/agent-card.json`, `/agents/:slug/card.png`, `/.well-known/agent-card.json`, 10 tests.

**The badges are currently reading invalid.** Not a contract problem: the pinned cards point at a temporary ngrok tunnel that has died. Every card URL returns 404, so the registry correctly reports `card_fetched: false` and `hash_matches_on_chain: false`. This is the single most urgent fix.

## The one structural risk

The card URL is inside the bytes that get hashed and pinned on chain. So hosting is not a deployment detail, it is part of the identity. Every hosting change forces a re-pin and a new card hash. Until the cards live somewhere we intend to keep, we will keep re-breaking our own badges. That is why stable hosting is task 1, not task 6.

## Phase 1: make the evidence true again (no new concepts)

1. **Choose the permanent card host.** Options, in order of preference:
   - `https://<engine-host>/agents/<slug>/agent-card.json` from the deployed engine. Best: same origin as the passport pages, one system to operate, and the card is served by the app rather than a laptop.
   - `https://raw.githubusercontent.com/tobi-techy/PENNY/main/agents/<slug>/agent-card.json`. Cheapest, needs the push, and raw GitHub sends `content-type: text/plain` with no configurable headers.
   - Long-lived tunnel with a reserved domain. Worst: still a laptop.

   Decision needed from you. My recommendation is the engine host, because it also gives the passport pages a stable home and removes the laptop from the loop.

2. **Set `CONCORDIUM_CARD_BASE_URL`** to the chosen base and rebuild all four cards.
3. **Re-pin** all four with `bun run concordium:register pin <slug> <card-url>`, then re-run `bun run concordium:verify` and confirm `badge_valid: true` with zero issues for all four.
4. **Guard against silent drift.** Run `bun run concordium:verify` on a schedule in CI, so a dead card host fails loudly instead of quietly invalidating four badges. This is the check that would have caught today's outage.

Done when: `CONCORDIUM_PROOF.md` shows four green badges against URLs we control, and CI re-checks them daily.

## Phase 2: make the identity binding real

5. **CIS-8 bind Penny's operator NEAR key.** Needs a testnet ed25519 key. Flow: build via the MCP builder, sign locally with the ops script, submit, then resolve back with `agent_by_external_reference` and assert it returns token 1169.
6. **Assert the binding inside `verify_agent`.** When a badge check returns an `external_reference`, surface the NEAR account so the tool can answer "is this agent the same operator as that NEAR account". That is the actual product claim and it is currently unproven.
7. **Passport page shows the binding.** One line: the owner's NEAR account, with the CIS-8 lookup that proves it.

Done when: `verify_agent` on Penny's badge returns both the Concordium owner and the bound NEAR account, and a test covers a mismatched binding.

## Phase 3: put the badge where the money decision happens

8. **Accountability fact on approval cards.** When the payee has a checked badge, add one fact line to the approval card. Constraint from `ARCHITECTURE.md`: do not touch `IntentPlan`, `planHash`, or the test vectors. Store the check result on the approval row, render it as a fact.
9. **`concordium_checks` append-only table.** Every `verify_agent` call writes subject, badge, network, verdict, checks, owner, checked at. No secrets, and no PII beyond a public badge string. This is the audit trail that makes the accountability claim concrete.
10. **Guard cites the verdict.** If Guard holds a recorded `invalid` or `revoked` verdict for a counterparty, the guard decision cites it. Still advisory: it must not silently block, and it must never claim a badge is required.

Done when: an approval card visibly carries the counterparty's badge verdict, and the verdict is reconstructable from the database after the fact.

## Phase 4: prove it end to end

11. **A live end-to-end test** (`apps/engine/test/concordium.e2e.test.ts`, skipped unless `CONCORDIUM_LIVE=1`) that hits the real registry for all four badges and asserts `verified`. Opt-in, so CI does not depend on a third party.
12. **Demo script pass.** Update `docs/CONCORDIUM.md` section 10 to the new URLs and the binding step.
13. **Submission text.** Components used, CCDExplorer links, production paragraph.

## What I need from you

- **Push approval** for `droid/add-concordium`, whenever you are ready. Nothing is pushed yet.
- **A hosting decision**: engine host, GitHub raw, or a reserved tunnel.
- **A testnet ed25519 NEAR operator key** for the CIS-8 binding. If you would rather not hand a key over, say so and I will write the signing step as a snippet you run yourself.

## Review findings from this pass

Three bugs found in my own work and fixed:

1. **Account lookups were silently broken.** The registry answers an owner account with `{account, agent_count, agents: []}`, not a single verdict. My schema rejected that as `invalid_response`, so `verify_agent` in account mode always returned `unavailable`. Added `verifyOwner`, which rolls up per-agent results and only reports `verified` when every agent passes. Live-confirmed against the four-agent account.
2. **Passport paths resolved against `process.cwd()`.** `bun run dev` runs from `apps/engine`, where `config/` and `agents/` do not exist, so the routes would 404 in dev. Now resolved from the module location, which works from the repo root, from `apps/engine`, and in a container at `/app`.
3. **The Docker image never copied `config/` or `agents/`.** The passport routes would have 404'd in production. Added both to the Dockerfile.

Also fixed: the passport cache ignored its config path, so two configs shared one cache entry.

One thing I left alone on purpose: `/agents` is not in `isWebPagePath`, so it gets its own header policy (`passportHeaders`) and stays indexable, unlike the approval pages. A passport that cannot be found is not a passport.
