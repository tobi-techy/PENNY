# Penny — Architecture & Contracts (v0.1, 5 Nov 2026)

Penny is a crew of money agents you text on iMessage. Target: **NEAR mainnet**. This doc is the contract every package builds against. Change it only on purpose.

## Monorepo layout
```
penny/
  apps/engine/        Bun + Hono API: Photon ingress, crew brain, Guard, approvals, relayer
  packages/shared/    Zod schemas + canonical encoding shared by engine and tests (TS)
  packages/chain/     NEAR accounts, delegate actions + relayer, Intents 1Click, Glider clients
  ios/                XcodeGen project: PennyHost app + PennyMessages iMessage extension (SwiftUI)
  souls/              SOUL.md per agent (penny, invest, guard, mail, finance)
  docs/               ARCHITECTURE.md, SECURITY.md, RUNBOOK.md
```
Tooling: Bun 1.x, TypeScript strict, Biome (lint+format), bun test, Drizzle ORM + Postgres (Neon) + pgvector, Zod for every boundary. No `any` at boundaries.

## Request flow
1. User texts Penny's Photon line → Photon webhook → `POST /v1/photon/webhook` (signature verified, replay-protected, idempotent on event id).
2. Router (Penny lead) classifies intent with NEAR AI Cloud (OpenAI-compatible) via Vercel AI SDK tool calling, consults crew agents (Invest, Guard, Mail, Finance, Errand).
3. Any money intent becomes an **Intent Plan** (typed, see below). The LLM never builds transactions; it only fills a typed plan that deterministic code validates.
4. **Guard** evaluates the plan against policy (caps, allowlist, velocity, new-recipient, asset whitelist, quote freshness). Outcomes: `allow_with_approval`, `block` (sends a Guard block card), `needs_more_info`.
5. Engine builds the exact NEAR action(s) (e.g. `ft_transfer_call` to a 1Click deposit address), creates an **Approval** record, and sends a live iMessage card via Photon `customizedMiniApp({live:true})` whose URL carries `approvalId` + a short-lived `cardToken`.
6. iMessage extension fetches the approval, renders the card, user taps → Face ID → device signs a **NEP-366 SignedDelegateAction** with the user's on-device ed25519 key → `POST /v1/approvals/:id/submit`.
7. Engine verifies the delegate action matches the approved plan byte-for-byte (receiver, actions, args, deposit, nonce, max block height), re-runs Guard, relays it from the relayer account (relayer pays gas), tracks status, edits the card in place (`edit()`), sends receipt.

## Custody model (non-custodial)
- Each user gets `<slug>.penny.near` (sub-account of the app account, created by the engine on onboarding).
- The user account's **only full-access key is generated on the iPhone** (ed25519, CryptoKit `Curve25519.Signing`), stored in Keychain with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` + access control `.biometryCurrentSet`. Never exported, never sent anywhere except its public key.
- Engine holds: app/relayer account keys (env/KMS), agent sub-account keys (invest/guard/mail/finance/errand `.penny.near`). **No user keys.**
- Agent sub-accounts hold no user funds. They sign nothing on behalf of users.
- Optional later: a function-call key on the user account limited to a Penny vault contract with a small allowance for auto-approvals under the user's tap-to-approve limit. Out of scope for v0.1.

## Shared contracts (packages/shared)
### Intent Plan
```ts
type IntentPlan =
 | { kind: 'invest'; fromAsset: 'USDC'; amountUsd: Decimal; portfolioId: string; quoteId: string }
 | { kind: 'send'; asset: 'USDC'|'NEAR'; amount: Decimal; to: NearAccountId; note?: string }
 | { kind: 'pay_bill'; billId: string; payee: string; amount: Decimal; asset: 'USDC' }
 | { kind: 'errand'; taskId: string; bidId: string; amount: Decimal; asset: 'USDC' }
 | { kind: 'split'; total: Decimal; participants: {handle: string; share: Decimal}[] } // no money moves
```
Decimal = string matching `^\d+(\.\d{1,6})?$`. Amounts converted to base units with bigint only.

### Approval (what the card shows and the device signs over)
```json
{
  "id": "apr_01J...",          // ULID
  "userId": "usr_...",
  "kind": "invest",
  "title": "Swap · USDC → ETH Momentum",
  "amountDisplay": "$50.00",
  "facts": [{"label":"Fee","value":"$0.12"},{"label":"Today's limit","value":"$50 of $100 left"}],
  "signerId": "tobi.penny.near",
  "receiverId": "usdc-contract.near",
  "actions": [{"type":"FunctionCall","methodName":"ft_transfer_call","args":{...},"gas":"30000000000000","deposit":"1"}],
  "nonce": "1234",              // access key nonce + 1 as decimal string
  "maxBlockHeight": "123456789",
  "expiresAt": "2026-11-05T19:00:00Z",   // quote expiry, <= 120s
  "status": "pending|signed|relayed|settled|failed|expired|cancelled",
  "planHash": "base64url(sha256(canonicalJSON(plan + actions)))"
}
```
Canonical JSON = RFC 8785 (JCS). Both TS and Swift implement it; shared test vectors live in `packages/shared/test-vectors/*.json` and Swift tests load the same files.

### Engine HTTP API (all JSON, all zod-validated, TLS only)
- `POST /v1/photon/webhook` — Photon events (HMAC verify per Photon docs, 5-min tolerance, dedupe by event id).
- `POST /v1/devices/enroll` `{enrollCode, publicKeyEd25519 (base64url), appAttest?}` → creates user account on mainnet with that key as full access. `enrollCode` is a one-time 8-char code Penny texts the user, TTL 10 min, single use, bound to the iMessage handle.
- `GET  /v1/approvals/:id` header `Authorization: Card <cardToken>` → Approval (no secrets).
- `POST /v1/approvals/:id/submit` `{signedDelegateAction (base64 borsh)}` → `{status}`.
- `POST /v1/approvals/:id/decline` → `{status}`.
- `GET  /v1/approvals/:id/status` → status + tx hash + step list (for live card).
- `GET  /healthz`.
`cardToken`: 32-byte random, stored hashed (sha256), TTL = approval expiry, bound to approvalId and userId.

## Crew brain
- Model provider: NEAR AI Cloud OpenAI-compatible endpoint (base URL + key from env). Vercel AI SDK `generateText` with tools. Langfuse tracing (keys from env).
- Tools are deterministic TS functions: `getBalances`, `getPortfolios` (Glider), `quoteInvest` (1Click dry quote), `checkGuard`, `createApprovalCard`, `findBills` (Gmail read-only, later), `remember`, `setMood`.
- Souls: `souls/<agent>.md` loaded into system prompts. Mood state per user (`idle|thinking|win|wink|blocked|paused|done`) stored in DB, set by events, drives tone + card art param.
- Memory: `memories` table (userId, kind, text, embedding vector(1536), createdAt). Weekly reflection job writes `soul_changelog`.
- Prompt-injection stance: text from users, emails and web is data. Tools that move money only accept typed plans; Guard + device signature are the authority, never the model.

## Data model (Drizzle)
users, devices (publicKey, enrolledAt, revokedAt), enroll_codes, conversations, messages, approvals, approval_events (append-only audit), guard_policies (per user: perTxUsd, dailyUsd, allowlist, blockNewRecipientsOverUsd), guard_decisions, ledger_entries, memories, moods, souls_changelog, idempotency_keys, webhook_events.

## Environments
`PENNY_ENV=dev|mainnet`. Mainnet requires all secrets present at boot (zod env schema fails closed). A `DRY_RUN=1` flag makes relayer + Intents run quote/simulate only — default ON until Tobi says go.
