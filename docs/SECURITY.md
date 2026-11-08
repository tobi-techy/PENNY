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
| Duplicate replacement cards | One replacement per approval, enforced by a unique index on `approvals.reissued_from`; a concurrent renew gets the same replacement, so the daily limit is held once |
| An email draft changed after Send | Edits only while the card is still a draft (compare-and-set on the card); after Send the plan is sealed in the approval, the card shows the write facts, and the phone and page show every argument in full before Face ID |
| Approval replay or a stolen card link | Every approval has `approvalHash` + a 32-byte challenge burned on the first approve attempt; the device signs hash + challenge behind Face ID (app) or a WebAuthn assertion over the challenge is verified on the server (link page); any failed check expires the approval and a new card is sent; a signature is never reused |
| Web passkey forged in the browser, or reused for another approval | The page checks the approval itself before signing (recomputes planHash and approvalHash from the plan and actions it signs, refuses a mismatch). The WebAuthn challenge is bound to the action: base64url(sha256(`penny-approval:v2:<approvalHash>:<challenge>`)). The engine, not the page, verifies the assertion (`@simplewebauthn/server`): that bound challenge, issued and unused, origin + rpId = PUBLIC_BASE_URL, UV flag, signature against the stored COSE key, sign count never goes backwards (synced passkeys report 0; a non-zero count must go up) |
| Card token in a URL path | 256-bit, hashed at rest, short TTL; access logs mask `/a/<token>`; pages and pictures are `no-store`, `no-referrer`, `noindex`; links are only built from PUBLIC_BASE_URL, never a request Host header |
| Lost phone or "that wasn't me" | `freeze` (text or the Not me button): every device key and passkey revoked for Penny, open approvals expired, enrollment refused while frozen. Texting `unfreeze` only sends an Unfreeze card; the keys come back only after Face ID on it, signed by a key the freeze switched off (device ed25519 over `penny-unfreeze:v1:<cardId>:<challenge>`, or that device's passkey), single use, 10 minutes. Whoever holds the messages can't undo a freeze. The on-chain key stays until the device removes it: deleting a key needs the account's own key, which Penny never holds |
| Webhook forgery | Photon signature verification with timestamp tolerance, constant-time compare, dedupe table |
| Device theft | Face ID with biometryCurrentSet (re-enrolling a face invalidates key); revoke device endpoint removes key on-chain via recovery flow (roadmap) |
| Relayer drained by gas griefing | Relay only delegate actions tied to a pending approval; per-user and global rate limits; gas cap per action |
| Intents quote manipulation | Quote expiry ≤120 s, min-received checked against slippage bound, deposit address must come from 1Click quote response bound to approval |
| Secrets leak | Env via zod schema; never logged (pino redact paths); no secrets in repo (gitleaks in CI); Glider key backend only |
| Data leak | Memories private per user; Gmail scope read-only; PII minimised; inference via NEAR AI Cloud, TEE attestation verified when `NEARAI_ATTESTATION` is on (docs/TEE.md) |
| Supply chain | Lockfile committed; pinned versions; `bun audit`/osv-scanner in CI |

## TEE attestation (NEAR AI Cloud)
Inference runs on NEAR AI Cloud in Intel TDX + NVIDIA confidential-computing GPUs. With `NEARAI_ATTESTATION=warn|enforce` the engine verifies, with a fresh nonce, the gateway and model TDX quotes (Intel DCAP via dcap-qvl), nonce and signer binding, MRCONFIGID and RTMR3, the model id, and the GPUs (NVIDIA NRAS), then checks each money/mail turn's response signature against the attested key. `enforce` refuses money and mail tools when any of that fails. Default `off` changes nothing. Only the nonce, model id and vendor evidence go to verifiers. Limits and sources: `docs/TEE.md`.

## Testnet proof routes
`PENNY_PROVE_SECRET` turns on `/v1/prove/*` for `bun run prove`. The env schema refuses it unless `NEAR_NETWORK=testnet` and not mainnet, and it must be at least 32 characters. The routes only bind a prove user to a testnet account and ask for a send through the normal Guard + approval path; approving still needs the device signature and every server check.

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
- Browser keys: the web approval key is WebCrypto Ed25519, non-extractable, in IndexedDB. There is no software fallback: a browser without WebCrypto Ed25519 gets no key and is told to use the iPhone app. The engine cannot distinguish a software-held key from a hardware-held one, so it must never be offered.
- Card links are built from the delivering host only when it is a real DNS name (or loopback in dev); a bare IP or malformed Host falls back to `PUBLIC_BASE_URL`.
- Sweepers: `pending` approvals expire oldest-first (no row may starve past the sweep limit), and `signed` rows older than 15 minutes are failed with their ledger reservation released, so a dead relay call cannot hold a user's daily limit hostage.
