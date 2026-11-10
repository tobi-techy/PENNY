# @penny/engine

Bun + Hono API: Photon ingress, crew brain, Guard, approvals, relayer hand-off. Binding contracts: `../../docs/ARCHITECTURE.md`, `../../docs/SECURITY.md`.

## Run it locally (dev, DRY_RUN)

| Do | See |
|---|---|
| `cp .env.example .env` at the repo root (leave secrets empty) | `PENNY_ENV=dev`, `DRY_RUN=1` |
| `bun install` | one lockfile at the root |
| `bun run dev` | `penny engine up {"env":"dev","dryRun":"1","relayLive":false}` on :8787 |
| `curl localhost:8787/healthz` | `{"ok":true}` |
| no `DATABASE_URL` | in-memory Postgres (pglite + pgvector), migrations applied at boot |
| no `NEARAI_API_KEY` | the crew answers "running without a brain" |
| `NEARAI_ATTESTATION=warn bun run dev`, `curl localhost:8787/v1/attestation` | NEAR AI TEE status, `"verified":true` (docs/TEE.md) |
| `bun scripts/nearai-attestation-live.ts` | one live end-to-end attestation check |
| no `SPECTRUM_*` | outbound iMessages go to a fake (debug log only) |
| `LOG_LEVEL=debug bun run dev` | fake iMessage sends in the log |
| `bun test` (from `apps/engine` or root) | all engine tests, no network |
| `bunx drizzle-kit generate` | new SQL migration in `drizzle/` after editing `src/db/schema.ts` |

Try a signed webhook locally:

```bash
SECRET=$(printf 'a%.0s' {1..64}); TS=$(date +%s)
BODY='{"event":"messages","space":{"id":"any;-;+15550100","platform":"iMessage","type":"dm"},"message":{"id":"spc-msg-1","platform":"iMessage","direction":"inbound","timestamp":"2026-11-05T19:00:00Z","sender":{"id":"+15550100","platform":"iMessage"},"content":{"type":"text","text":"hi"}}}'
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
SPECTRUM_WEBHOOK_SECRET=$SECRET bun run dev &
curl -s localhost:8787/v1/photon/webhook -H "x-spectrum-timestamp: $TS" -H "x-spectrum-signature: $SIG" -H 'content-type: application/json' -d "$BODY"
# -> {"ok":true}; Penny replies (fake) with an 8-char enroll code
```

Mainnet boot is refused until the real `ChainPort` from `packages/chain` is wired in `src/main.ts`.

## Migrations

SQL migrations live in `drizzle/` and are applied at boot (in-memory pglite in dev, Postgres when `DATABASE_URL` is set). Run `bunx drizzle-kit generate` after editing `src/db/schema.ts`.

- A fresh database runs the whole set in order: `0000..0009`, ending with the last migration (`0009`, which adds the approvals bill-claim column/index and reminder retry fields). The set is additive, so a database already at main's `0007_card_status_line` can apply `0008` and `0009`.
- A database that ran an earlier shape of this branch cannot be upgraded by the merged journal. Drizzle decides what to apply from each migration's recorded `when` timestamp, and the numbering changed when main was merged in. Two shapes were observed:
  - last migration `0004`/`0005` from before the merge (`when` 1794169088366): main's `0005_live_cards` looks already applied and is skipped, then `0006_reissue_once` aborts because the `reissued_from` column is missing.
  - a database from merge commit `9725f57`: the branch's `0006` was recorded with `when` 1794173982204, so main's `0006` and `0007` are skipped for good. The `reissued_from` partial index and `cards.status_line` are then missing, and the engine fails at run time.
- For either shape, drop and recreate the database, then run `0000..0009` from empty. There is no repair path; only a fresh database is supported.

## Layout

```
src/env.ts                 zod env, fails closed; relayLive = mainnet && DRY_RUN=0 && relayer key
src/db/                    Drizzle schema (all contract tables + bots), pglite/postgres clients
drizzle/                   SQL migrations (pgvector ext, append-only trigger on approval_events)
src/guard/policy.ts        pure Guard: per-tx, rolling daily, allowlist, new-recipient, assets, quote freshness, velocity, bot caps
src/guard/bot-policy.ts    pure rules for create_bot (risk -> plain confirm | Face ID)
src/approvals/             state machine, cardToken, ApprovalService (create, submit, decline, status, expiry)
src/brain/registry.ts      tool registry: id, description, zod input, risk read|write|money; per-bot enforcement
src/brain/tools.ts         built-in tools (money tools only produce typed IntentPlans -> Guard -> card)
src/brain/bots.ts          built-in crew seeded as rows; create_bot drafting/confirm/activation
src/brain/crew.ts          router (picks among the user's active bots) + bot runner (Vercel AI SDK)
src/brain/model.ts         NEAR AI Cloud provider + embedder
src/brain/{mood,memory,tracing}.ts
src/ports/                 ChainPort, MessagingPort (+ fakes), Spectrum iMessage adapter
src/photon/verify.ts       Spectrum webhook HMAC check
src/http/                  routes, idempotency, security middleware
src/inbound.ts             verified webhook event -> onboarding or crew reply
```

## Bots are data

`bots` rows (built-ins have `user_id = null`). Each bot has a SOUL, `tool_ids`, and `permissions {canMoveMoney, perTxCap, dailyCap}`. The router only sees the user's **active** bots. Penny's `draft_bot` tool fills a `create_bot` IntentPlan; Guard checks it:

- read-only tools → `pending_confirm` → user says yes → `confirm_bot` → active
- any write or money tool → `pending_approval` + Face ID card (device signs `penny-approval:v1:<approvalId>:<planHash>` with its enrolled ed25519 key) → active
- money tools need a user-granted cap ≤ the user's own limits; the registry also drops money tools from any custom bot without both caps at run time, and Guard enforces the bot's caps on every payment.

## Verified external details (5 Nov 2026)

- Photon (Stable): HMAC `v0=hex(HMAC_SHA256(secret, "v0:{ts}:{rawBody}"))`, 5-min tolerance, 400 on missing/stale, 401 on bad sig, dedupe on `X-Spectrum-Webhook-Id` + `message.id`. https://photon.codes/docs/webhooks/verifying-signatures.md · https://photon.codes/docs/webhooks/delivery.md · https://photon.codes/docs/webhooks/events.md
- Outbound via `spectrum-ts` cloud iMessage, `customizedMiniApp({live:true})` + `edit()`. https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/apps.md
- NEAR AI Cloud: `https://cloud-api.near.ai/v1`, default chat model `z-ai/glm-5.3-flash`, embeddings `Qwen/Qwen3-Embedding-0.6B` (1024-d, padded to the contract's 1536). https://docs.near.ai/api-reference/introduction · `GET https://cloud-api.near.ai/v1/models`
