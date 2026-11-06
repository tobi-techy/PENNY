# Penny — Security Model (v0.1)

Mainnet money. Default posture: fail closed, least privilege, every money step needs the user's Face ID signature.

## Assets
User funds on `<slug>.penny.near`; relayer/app account keys; agent sub-account keys; Glider B2B key; Photon secret; NEAR AI + Langfuse keys; user memories and email-derived data.

## Threats → controls
| Threat | Control |
|---|---|
| Model hallucinates or is prompt-injected into moving money | LLM only fills typed IntentPlan; deterministic builder creates actions; Guard policy; device signature required; delegate action verified byte-for-byte against approved planHash |
| Server compromise steals user funds | Server holds no user keys. User full-access key lives in iPhone Keychain behind biometryCurrentSet. Attacker can at most send fake cards; device shows decoded actions from the delegate action it signs, not server prose |
| Card spoofing / replay | cardToken random 256-bit, hashed at rest, TTL ≤ quote expiry, single approval; delegate action carries nonce + maxBlockHeight; approvals single-use; status machine rejects re-submit |
| Webhook forgery | Photon signature verification with timestamp tolerance, constant-time compare, dedupe table |
| Device theft | Face ID with biometryCurrentSet (re-enrolling a face invalidates key); revoke device endpoint removes key on-chain via recovery flow (roadmap) |
| Relayer drained by gas griefing | Relay only delegate actions tied to a pending approval; per-user and global rate limits; gas cap per action |
| Intents quote manipulation | Quote expiry ≤120 s, min-received checked against slippage bound, deposit address must come from 1Click quote response bound to approval |
| Secrets leak | Env via zod schema; never logged (pino redact paths); no secrets in repo (gitleaks in CI); Glider key backend only |
| Data leak | Memories private per user; Gmail scope read-only; PII minimised; inference via NEAR AI Cloud |
| Supply chain | Lockfile committed; pinned versions; `bun audit`/osv-scanner in CI |

## Rules for code
- bigint for all base-unit math; no floats for money.
- Every external input parsed with zod; reject unknown keys on money paths.
- Constant-time comparisons for secrets/tokens.
- Append-only audit (`approval_events`) for every state change.
- Idempotency keys on all POSTs that cause side effects.
- Structured logging with redaction; no request bodies on money routes in logs.
- `DRY_RUN=1` default; mainnet relay requires `PENNY_ENV=mainnet` AND `DRY_RUN=0` AND relayer key present.
- Testnet exception: when `NEAR_RPC_URL` is a testnet host (and `NEAR_NETWORK` is unset or `testnet`), `DRY_RUN=0` + relayer key broadcasts on testnet without `PENNY_ENV=mainnet`. The `NEAR_NETWORK=testnet` label alone never unlocks this: an unset or non-testnet RPC falls back to the mainnet rules.
- Tests required for: Guard policy, canonical JSON vectors, delegate-action verification, webhook signature, approval state machine, cardToken auth.
