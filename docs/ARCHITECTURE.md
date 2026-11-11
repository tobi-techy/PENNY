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
5. Engine builds the exact NEAR action(s) (e.g. `ft_transfer_call` to a 1Click deposit address), creates an **Approval** record (with `approvalHash` and a single-use `challenge`, see below) and a **Card** for it, and sends the card through the one card sender. If Guard said no, the Blocked card is sent instead and no approval exists.
6. Card picker, per user: an active `ios_app` device with the iMessage extension gets a **live card** (Photon `customizedMiniApp({live:true})`, cloud package `@spectrum-ts/imessage`); everyone else gets a **link card** (a URL whose Open Graph image is the card, rendered on the server at 1200x630). Both use `PUBLIC_BASE_URL/a/<cardToken>`.
7. App path: the extension reads the token, `GET /v1/approvals/by-token/:token`, recomputes `approvalHash` from the plan + actions it will sign, Face ID unlocks the Keychain key, the device signs `penny-approval:v2:<approvalHash>:<challenge>` and the **NEP-366 SignedDelegateAction** (or the plan message for writes and new bots) → `POST /v1/approvals/:id/sign`. Link path: the page asks for the passkey (WebAuthn, challenge = the approval's challenge, UV required) → `POST /v1/approvals/:id/passkey`; the engine verifies the assertion on the server, then the browser key's signed action.
8. Engine checks, in order: card token, not frozen, pending, challenge unused (burned now), device or passkey enrolled to this user and not revoked, not expired, the action still matches the hash, the signature; then Guard again, the delegate action byte-for-byte (receiver, actions, args, deposit, nonce, max block height = the deadline), relays it from the relayer account (relayer pays gas), tracks status, and updates the card (live: edited in place, 3 tries with backoff then a fresh card; link: a fresh link card for Done, Sent, Blocked, Failed, Expired). Any failed check expires the approval and Penny sends a new card; a signature is never reused.

## Custody model (non-custodial)
- Each user gets `<slug>.penny.near` (sub-account of the app account, created by the engine on onboarding).
- The user account's **only full-access key is generated on the iPhone** (ed25519, CryptoKit `Curve25519.Signing`), stored in Keychain with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` + access control `.biometryCurrentSet`. Never exported, never sent anywhere except its public key.
- Engine holds: app/relayer account keys (env/KMS), agent sub-account keys (invest/guard/mail/finance/errand `.penny.near`). **No user keys.**
- Agent sub-accounts hold no user funds. They sign nothing on behalf of users.
- Optional later: a function-call key on the user account limited to a Penny vault contract with a small allowance for auto-approvals under the user's tap-to-approve limit. Out of scope for v0.1.

## Guard (shared contract)

`contracts/guard` is one shared on-chain policy engine, e.g. `guard.penny-tobi.testnet`. It is the half of the custody model that lets an agent spend without holding the user's key.

- **Locked account.** The contract account has no access keys, so nobody can redeploy, upgrade or drain it. Changing the code means deploying a new contract and pointing `PENNY_GUARD_CONTRACT` at it. The wasm is built from `contracts/guard`, with tests and a checksum in CI.
- **Funding and policy in one call.** An owner funds their own budget with `ft_transfer_call`; the `msg` can set policies for agents in the same call. Owner methods act only on `predecessor_account_id`.
- **Policy per owner and agent.** Each policy lists allowed tokens with per-tx and UTC-day caps, an optional recipient allowlist, and an optional expiry. Pause and revoke are separate flags. A token with no limit entry is not spendable.
- **Agent spend.** An agent calls `spend(owner_id, token, recipient, amount, memo, nonce)` from its own account. The guard checks that the caller is the agent in that owner's policy, the token is allowed, the amount is under both caps, the recipient is allowed, the policy is not paused, revoked or expired, and the nonce is newer than the last one. Only then does it call `ft_transfer` on the token.
- **Rollback.** A failed `ft_transfer` (for example, the recipient is not registered with the token) runs the callback, which restores the owner's budget and the agent's day counter. Gas is checked before the transfer so the callback cannot be starved: `spend` and `withdraw` require at least 45 Tgas.
- **Bounds.** Up to 8 tokens and 8 limits per policy, 64 allowlist entries, 16 agents per owner, 128-byte memo. State is keyed by owner and agent and never iterated globally, so one owner cannot make another owner's call more expensive.
- **Two layers.** The engine evaluates the same policy before it shows a card and again before it relays. The on-chain guard is the backstop for agent spending. A user's own send, bill payment or swap is a delegate action signed by the user's device, not a guard spend; the guard does not hold the user's key and cannot sign for them.
- **Errors.** Stable `E_*` codes map to the engine's Guard cards, so a revert is shown in plain words instead of a raw panic.

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

### Approval hash and challenge (live cards)
- `approvalHash = base64url(sha256(JCS({ action, expiresAt, id, planHash })))`, `action = {type, to, amount, asset}` derived from the plan (`approvalActionOf` in packages/shared; Swift `ApprovalIntent`). Vector: `packages/shared/test-vectors/09-approval-hash.json`.
- `challenge`: 32 random bytes (base64url), single use, burned on the first approve attempt whatever its outcome.
- Web passkey challenge (link page): base64url(sha256(`penny-approval:v2:<approvalHash>:<challenge>`)), so the passkey answer is tied to this exact action. The page recomputes the hashes before it asks.
- A replaced approval (`reissued_from`) has at most one replacement (unique index).
- Lifetime: 90 s for anything priced by a quote (invest), 10 min for plain sends, bills, errands, writes and new bots. The NEAR max block height is set to cover the lifetime.
- States reuse the approval state machine: card Ready = `pending`, Approving = `signed`/`relayed`, Sent = `settled`, Blocked = Guard `cancelled` (or no approval at all when Guard said no first), Expired = `expired`.

### Card (packages/shared `Card`)
`{ id, userId, agent, kind: info|approval, type, title, amount?, lines[], buttons[], state, approvalId?, expiresAt?, receiptUrl?, createdAt }`. Cards carry `statusLine`: what happened, exactly as the server knows it (e.g. "couldn't confirm this went through" after a relay error); clients show it instead of generic copy, and "nothing moved" is only said when it is certain. Link cards get a fresh message only for an outcome the user caused (sent, blocked, failed); an unanswered card expiring sends nothing and shows Expired when opened. Types: the DESIGN.md table plus `reminder`, `email_draft`, `plan`, `found`, `done`, `connect`, `setup`; unknown types render as a plain card. A finished card names its own outcome (`settledPill`: Sent, Paid, Created, Unfrozen), so one pill never says "Sent" on a bot. Which actions need Face ID is decided only by `needsApproval()` (apps/engine/src/cards/policy.ts): read tools never, money and write tools always, anything new that writes defaults to yes. Info card buttons that change something small (Undo, Edit, Pick) need no Face ID; a button that sends, pays or posts turns the card into an approval card first.

### Engine HTTP API (all JSON, all zod-validated, TLS only)
- `POST /v1/photon/webhook` — Photon events (HMAC verify per Photon docs, 5-min tolerance, dedupe by event id).
- `POST /v1/devices/enroll` `{enrollCode, publicKeyEd25519 (base64url), appAttest?}` → creates user account on mainnet with that key as full access. `enrollCode` is a one-time 8-char code Penny texts the user, TTL 10 min, single use, bound to the iMessage handle.
- `GET  /v1/approvals/:id` header `Authorization: Card <cardToken>` → Approval (no secrets).
- `GET  /v1/approvals/by-token/:token` → `{ card, approval?: { id, action, approvalHash, challenge?, expiresAt, status, passkeys?, detail: Approval } }`.
- `POST /v1/approvals/:id/sign` (Card auth) `{deviceId, signature, signedDelegateAction | planSignature}` → `{status}` (app).
- `POST /v1/approvals/:id/passkey` (Card auth) `{assertion, signedDelegateAction | planSignature}` → `{status}` (link page; WebAuthn verified on the server).
- `POST /v1/approvals/by-token/:token/renew` → `{approvalId | null}`: a fresh card ("Get a new card"), or none (Guard said no, too many replacements).
- `POST /v1/approvals/by-token/:token/fresh-price` → invest only: opening the card replaces a quote with under 75 s left by a fresh one on the same card and link (no new message; at most 8 per card; never once Face ID started).
- `POST /v1/cards/by-token/:token/press` `{buttonId}`, `POST /v1/cards/by-token/:token/edit` `{text}` → info card buttons.
- `GET /setup` (setup link card; the one-time code stays in the URL fragment) and `GET /c/:token` (connect card).
- `POST /v1/cards/by-token/:token/unfreeze` `{deviceId, signature} | {assertion}` → Face ID on an Unfreeze card (texting "unfreeze" only sends the card).
- `POST /v1/devices/passkey/challenge` `{enrollCode}` → registration challenge for web enrollment (`platform: web_passkey` + `passkey` on `/v1/devices/enroll`).
- `GET /a/:token` (page + Open Graph tags), `GET /a/:token/card.png` (the card for its current state).
- `POST /v1/approvals/:id/submit` is retired (410): it had no challenge check.
- `POST /v1/prove/*` testnet proof routes, only with `PENNY_PROVE_SECRET` (refused on mainnet).
- `POST /v1/approvals/:id/decline` → `{status}`.
- `GET  /v1/approvals/:id/status` → status + tx hash + step list (for live card).
- `GET  /healthz`.
`cardToken`: 32-byte random, stored hashed (sha256), TTL = approval expiry (info cards: 24 h), bound to one card (and its approval) and user. It is the URL path (`/a/<token>`), so access logs mask it.

## Crew brain
- Model provider: NEAR AI Cloud OpenAI-compatible endpoint (base URL + key from env). Vercel AI SDK `generateText` with tools. Langfuse tracing (keys from env).
- Tools are deterministic TS functions: `getBalances`, `getPortfolios` (Glider), `quoteInvest` (1Click dry quote), `checkGuard`, `createApprovalCard`, `findBills` (Gmail read-only, later), `remember`, `setMood`.
- Souls: `souls/<agent>.md` loaded into system prompts. Mood state per user (`idle|thinking|win|wink|blocked|paused|done`) stored in DB, set by events, drives tone + card art param.
- Memory: `memories` table (userId, kind, text, embedding vector(1536), createdAt). After each turn a background learner extracts durable facts from what the user said (deduped; secrets and third-party instructions refused). Weekly reflection job writes `soul_changelog`.
- Reply shape: the model is told to text in one or two sentences; `lib/reply.ts` also strips assistant filler and splits long answers at sentence boundaries into short bubbles (four at most). Links and code stay whole, and every word is kept.
- Prompt-injection stance: text from users, emails and web is data. Tools that move money only accept typed plans; Guard + device signature are the authority, never the model.

### Follow-up loop (proactivity)
Penny is allowed to text first, but only through a deterministic loop, never from the model's mood.

- **Open loops.** After a turn the background learner may record at most one open loop (`open_loops`): an offer the user did not answer, a decision they left hanging, a goal or errand. A raw "want me to …?" reply also becomes a loop even if the learner misses it. Loops are data, not instructions, and there is no to-do UI.
- **Event-driven tick, not polling the model.** `followup_due` runs every 60 s and does one indexed query for loops whose `dueAt` has passed. A due loop is claimed before composing, so a deploy overlap cannot text the same person twice. No model is called until a loop is due and the gate passes; doing nothing is the default.
- **Deterministic gate** (`brain/followup.ts`, pure and tested): quiet hours 20:00–08:00 in the user's learned zone, falling back to the engine's `PENNY_TIMEZONE`; one follow-up a day on `steady` and two on `eager`, at least 6 h since the user or Penny last spoke, and a score floor. `quiet` sends none. Every refusal has a reason in the log.
- **Composition and silence.** The model gets the one loop, the recent thread and an autonomy header. It writes one short plain sentence, or `SKIP`; `SKIP` drops the loop. Model failure falls back to a fixed sentence. Links, markdown and emoji are stripped before sending.
- **Autonomy calibration.** `followups.score` (0–100) is the profile header: a reply to a follow-up raises it, 48 h of silence lowers it, two unanswered nudges drop the loop. `be quiet`, `be normal` and `be more proactive` are commands handled before the model and set the score explicitly.
- **Live-turn awareness.** Every turn receives the same profile header (open loops with ids, autonomy, the last unanswered text), so Penny can close a loop with `close_open_loop` when the user settles it instead of following up later.
- **Boundaries.** Proactivity only sends text. It never creates an approval, moves money, retries a failed action or overrides Guard. A card, an approval and Face ID remain the only path to an action in the user's name. A follow-up never repeats an existing bill, reminder or connect notification; those keep their existing jobs.

## Data model (Drizzle)
users (frozenAt), devices (publicKey, platform ios_app|web_passkey, hasExtension, enrolledAt = createdAt, revokedAt, revokedReason), passkeys (credentialId, COSE publicKey, signCount, platform web_passkey), cards, reminders, enroll_codes, conversations, messages, approvals, approval_events (append-only audit), guard_policies (per user: perTxUsd, dailyUsd, allowlist, blockNewRecipientsOverUsd), guard_decisions, ledger_entries, memories, moods, followups (score, quietStart, quietEnd, timezone), open_loops (kind, summary, status, dueAt, nudgeCount), proactive_messages (text, loopIds, sentAt, repliedAt, outcome), souls_changelog, idempotency_keys, webhook_events.

## Environments
`PENNY_ENV=dev|mainnet`. Mainnet requires all secrets present at boot (zod env schema fails closed). A `DRY_RUN=1` flag makes relayer + Intents run quote/simulate only — default ON until Tobi says go.
