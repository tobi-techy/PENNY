# AGENT.md

Instructions for coding agents (Claude Code, Codex, Cursor, etc.) working on Penny. Read this before you write any code.

## What Penny is

A multi-agent crew that lives in iMessage. Penny (the lead) routes plain-text asks to specialist agents: Invest, Guard, Mail, Finance, Errand, and bots the user creates (an X manager, a GitHub bot, anything). Money is one of the things they handle, and the one with the strictest rules. Every agent has a soul (`souls/*.md`), tools from a registry, permissions, and its own NEAR sub-account. Results show up as live cards in the iMessage thread. Anything that spends or acts in the user's name needs Face ID on the user's iPhone.

Read, in this order:
1. `docs/IDEA.md` (what and why)
2. `docs/ARCHITECTURE.md` (binding technical contract)
3. `docs/SECURITY.md` (binding security contract)
4. `docs/DESIGN.md` (conversation, cards, states, copy)

If your change conflicts with ARCHITECTURE.md or SECURITY.md, stop and propose a doc change first. Do not quietly diverge.

## Repo map

```
apps/engine/        Bun + Hono API. Photon webhook, router, crew, Guard, approvals, relayer. Drizzle (Postgres + pgvector).
packages/shared/    zod schemas (IntentPlan, Approval, API bodies), bigint money helpers, RFC 8785 canonical JSON, planHash, test vectors.
packages/chain/     NEAR: sub-accounts, NEP-366 delegate action verify + relay, NEAR Intents 1Click client, Glider client. ChainAdapter.
ios/                XcodeGen project. PennyHost (pairing, limits, crew, device), PennyMessages (iMessage extension, live cards), PennyKit (keys, Borsh, NEP-366, JCS, API client, card UI).
souls/              SOUL.md per built-in agent.
docs/               IDEA, DESIGN, ARCHITECTURE, SECURITY.
design/, brand/     Approved card renders and brand SVGs. Visual source of truth.
```

## Commands

```bash
bun install
bun run typecheck
bun test
bun run lint        # biome
bun run dev         # engine on localhost, DRY_RUN=1
```

iOS (on a Mac): `brew install xcodegen && cd ios && xcodegen generate`, open `Penny.xcodeproj`, set your team, run on device. See `ios/README.md`.

## Non-negotiable rules

### Money and keys
- **Non-custodial.** The user's only full-access NEAR key is created on the iPhone and never leaves it. The backend never stores, receives, logs or generates user private keys. Agent sub-accounts never hold user funds.
- **Every money move is a NEP-366 SignedDelegateAction** signed on device after Face ID, relayed by our relayer. The engine verifies the signed action against the approved `planHash` byte for byte before relaying.
- **The LLM never builds transactions.** It only fills typed IntentPlans (zod). Deterministic code builds actions. Guard checks policy before any card is shown.
- **bigint for all money.** No floats, no `Number` for amounts. Use the helpers in `packages/shared`.
- **`DRY_RUN=1` is the default.** Mainnet needs `PENNY_ENV=mainnet`, `DRY_RUN=0` and the relayer key, and the engine fails closed at boot if anything is missing.
- **Never** send a mainnet transaction, spend funds, or run anything that broadcasts, unless the human explicitly asks for that exact action.

### Actions in the user's name
- Tools have a risk level: `read`, `write`, `money`. Write and money tools always go through Guard and an approval card. Custom bots get no money tools unless the user grants a cap with Face ID.
- **Mood never touches money or permissions.** Souls and moods change wording, tapbacks and card art only.

### Secrets
- Never commit secrets, keys, tokens, `.env` files or real user data. Use `.env.example` with placeholders.
- Keys (Glider, Photon, NEAR AI, Langfuse, relayer) are backend-only and come from env. Never ship them to iOS or a web page.
- Logs go through pino with redaction. Never log card tokens, signatures in full, emails or message bodies at info level.

### Boundaries and data
- zod at every boundary (webhooks, API bodies, LLM output, third-party responses).
- Canonical JSON (RFC 8785) for anything hashed or signed. TS and Swift share `packages/shared/test-vectors`; if you change encoding, update the vectors and both test suites.
- Verify Photon webhooks (HMAC, timestamp tolerance, dedupe by event id) before doing anything.
- `approval_events` is append-only. Use idempotency keys on every write endpoint.
- Card tokens: 32 random bytes, stored as sha256, constant-time compare, short TTL.

## Code style

- TypeScript strict, ESM, Bun. Biome for lint and format. No `any` without a comment saying why.
- Small files, one job each. Pure functions for policy (Guard) so they are easy to test.
- Ports and adapters: engine talks to `ChainPort`, `MessagingPort`, model provider and embeddings through interfaces with fakes for tests.
- Swift 5.10+, iOS 17+, SwiftUI. CryptoKit for keys, LocalAuthentication for Face ID, Keychain with `.biometryCurrentSet` and `WhenPasscodeSetThisDeviceOnly`.
- User-facing copy follows `docs/DESIGN.md`: short, plain, lowercase for Penny, never "transaction", "gas", "nonce" or "delegate action" in the UI.

## Tests

- Every change ships with tests. `bun test` must be green before you commit.
- Guard, approvals, canonical JSON, delegate-action verification and money helpers need thorough unit tests, including failure cases.
- Mock all network calls in tests. Read-only mainnet smoke scripts live in `packages/chain/scripts` and are never run in CI.

## Commits

- Small, focused commits with clear messages: `engine: add guard velocity rule`, `ios: card expired state`, `docs: ...`.
- Commit as you go. Run typecheck, tests and lint before each commit.
- The repo is public. Check `git diff --staged` for secrets before every commit. CI runs gitleaks.

## When unsure

- Ask the human rather than guess on anything touching money, keys, permissions or the public repo.
- Prefer the simplest thing that keeps the security rules intact.
- If a third-party API (Photon, NEAR Intents, Glider, NEAR AI Cloud) behaves differently from the docs, write down what you saw in the relevant package README and adjust the adapter, not the contract.
