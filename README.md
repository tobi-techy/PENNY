# PENNY
Penny is a crew of AI agents that helps run your everyday life from iMessage. Text it like a friend — "what's in my inbox that matters?", "pay my DStv", "put $50 somewhere safer", "find someone to fix the tap" — and the crew gets to work: Mail reads your inbox, Finance keeps the picture straight, Errand finds people for small jobs, Invest builds a portfolio, Guard checks anything that acts in your name. Every action that matters shows up as a card in your thread, and nothing happens until you approve it with Face ID. Your keys live on your phone, the agents have their own NEAR accounts, and money moves across chains through NEAR Intents. Penny has a soul too: it remembers you, has moods, and gets better every week.

## Features

- Crew of agents in iMessage (Penny, Invest, Mail, Guard, your own bots), with memory and moods
- Every money move is a card approved with Face ID; server holds no user keys
- NEAR accounts per user and agent, delegate actions + relayer, NEAR Intents across chains
- Invest via NEAR Intents 1Click: "put $50 in SOL" gets a live preview (est. out, rate, fee, min received, expiry), Guard, a firm quote on a Face ID card, then the card follows the swap (pending, processing, success / refunded / failed). ETH, SOL, NEAR; real quotes and prices, mainnet broadcast off until explicitly enabled (see `docs/INVEST.md`)
- Guard before every card and again before relay: per-tx, daily, new-recipient and velocity rules, with mainnet launch caps on both per-tx and daily total; relayer limit per approval comes from the approved amount, bounded by an env ceiling
- Bills and reminders: Mail checks connected Gmail for bills (known Nigerian billers, amount and due date parsed by code, receipts skipped), texts you when a new one lands, and reminds you at 09:00 the day before it's due. "remind me to call mum at 6" works too. Paying a bill only goes to a payee from the fixed biller list, never one taken from an email. Real billers aren't payable yet; the demo biller is (below)
- Smooth first contact: the first text gets a short welcome and Penny answers what you asked (a bare "hi" gets a first step). No setup link up front: it's texted only when something needs approval, and Penny confirms in the thread once the browser is linked. "connect my gmail" sends a link; Penny notices the connection on her own, says so, and checks for bills straight away
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

## Demo: pay a bill with real testnet NEAR

| Do | See |
|---|---|
| Create a testnet account for the biller, e.g. `penny-demo-biller.testnet` | it exists on [testnet NearBlocks](https://testnet.nearblocks.io) |
| Set `NEAR_RPC_URL=https://rpc.testnet.near.org` (plus the testnet app/relayer keys) and `PENNY_DEMO_BILLER_ACCOUNT=penny-demo-biller.testnet` | engine boots; testnet broadcasts for real |
| Text Penny, open the setup link, then send your Penny account a few testnet NEAR from the faucet | new accounts start with 0.002 NEAR; Penny tells you the account id if it's short |
| Text "connect my gmail" and authorize | Penny texts "gmail's connected ✓" and checks for bills |
| Email yourself: subject `Penny Demo Utility bill: $5.00 due <date>` | Mail texts you about the new bill |
| Text "pay it" | a card: `$5.00 · ~N NEAR (testnet)`, paying `penny-demo-biller.testnet` |
| Approve | the card goes to done, the bill is crossed off, Penny texts a NearBlocks receipt link |

On testnet bills are paid in NEAR (there is no testnet USDC), converted at the live NEAR price and rounded up. Guard still sizes and caps the payment in dollars. On mainnet the same flow pays USDC.

## Safety defaults

- `DRY_RUN=1` until someone explicitly says go. Live relay needs `PENNY_ENV=mainnet` **and** `DRY_RUN=0` **and** a relayer key; the env schema fails closed.
- No user keys on the server. Ever.
- Mood never overrides money rules.
- `NEARAI_ATTESTATION=enforce` in `.env.example` (code default `off`). `enforce` needs `NEARAI_API_KEY` and blocks money and mail turns unless NEAR AI's TEE attestation and the response signature verify.
