# PENNY
Penny is a crew of AI agents that run your money from iMessage. Text it like a friend, "put $50 somewhere safer" or "pay my DStv", and the crew gets to work: Invest builds a portfolio, Mail finds the bill, Guard checks your limits. Every move shows up as a card in your thread, and nothing happens until you approve it with Face ID. Your keys live on your phone, the agents have their own NEAR accounts, and money moves across chains through NEAR Intents. Penny has a soul too: it remembers you, has moods, and gets better every week.

## Features

- Crew of agents in iMessage (Penny, Invest, Mail, Guard, your own bots), with memory and moods
- Every money move is a card approved with Face ID; server holds no user keys
- NEAR accounts per user and agent, delegate actions + relayer, NEAR Intents across chains
- Connected apps (Composio) with write approvals; App Attest for the iOS device
- Private inference on NEAR AI Cloud with TEE attestation: Intel TDX + NVIDIA GPU evidence and per-response signatures verified, `private · verified in TEE` status at `GET /v1/attestation` (`NEARAI_ATTESTATION=off|warn|enforce`, see `docs/TEE.md`)

Start here: `AGENT.md`, then `docs/IDEA.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DESIGN.md`.

## Repo

```
apps/engine/      Bun + Hono API (webhook, crew, Guard, approvals)
packages/shared/  zod schemas, bigint money, RFC 8785 canonical JSON, planHash, test vectors
packages/chain/   NEAR accounts, delegate actions + relayer, Intents, Glider
ios/              PennyHost app + PennyMessages extension
souls/            one SOUL file per built-in agent
docs/             contracts and design
```

## What works today

- **Crew in iMessage**: Penny routes asks to Invest, Guard, Mail, Finance, Errand and bots you create; souls, moods, memory, weekly reflection.
- **Invest (NEAR Intents 1Click)**: "put $50 in SOL" -> live preview (est. out, rate, fee, min received, expiry) -> Guard -> firm quote -> Face ID card -> USDC deposit via NEP-366 delegate action -> card follows the swap (pending, processing, success / refunded / failed). ETH, SOL, NEAR. Real quotes and prices; mainnet broadcast stays off until explicitly enabled. See `docs/INVEST.md`.
- **Send USDC / NEAR**: Guard-sized (live NEAR price), Face ID, relayed delegate action; relayer limit per approval comes from the approved amount, bounded by an env ceiling. Proven live on testnet.
- **Guard**: per-tx, daily (mainnet launch caps clamped on both), new-recipient and velocity rules, run before every card and again before relay.
- **Connectors**: Gmail/GitHub via Composio; writes need a Face ID card.

## Local run (dev, DRY_RUN)

| Do | See |
|---|---|
| install Bun 1.4 (`curl -fsSL https://bun.sh/install \| bash`) | `bun --version` |
| `bun install` | one root `bun.lock` |
| `cp .env.example .env` | dev defaults, `DRY_RUN=1` |
| `bun run typecheck` | no output = good |
| `bun test` | all suites green, no network |
| `bun run lint` | Biome clean |
| `bun run dev` | engine on http://localhost:8787, `/healthz` → `{"ok":true}` |

More: `apps/engine/README.md`. iOS: `ios/README.md`.

## Safety defaults

- `DRY_RUN=1` until someone explicitly says go. Live relay needs `PENNY_ENV=mainnet` **and** `DRY_RUN=0` **and** a relayer key; the env schema fails closed.
- No user keys on the server. Ever.
- Mood never overrides money rules.
- `NEARAI_ATTESTATION=enforce` in `.env.example` (code default `off`). `enforce` needs `NEARAI_API_KEY` and blocks money and mail turns unless NEAR AI's TEE attestation and the response signature verify.
