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

## Try it

Text Penny's number on iMessage. Everything Penny does or proposes shows up as a card in the thread: a reminder set, an email drafted, a bill found, a payment. Small things (Undo a reminder, Edit a draft) are one tap. Anything that spends money or acts in your name (send, pay, post, send an email) needs Face ID. There are two ways to get the cards:

**1. With the app (live cards).** Install Penny from TestFlight, open it once and tap the setup link Penny texted you. Your key is made on the phone, behind Face ID, and never leaves it. From then on cards are live iMessage cards that change in place. Try:

- "send 0.1 NEAR to amara.testnet" → a Send card with a countdown → Approve with Face ID → the card flips to Sent with a receipt link.
- "remind me to call mum at 7" → "Reminder set for 7am" with Undo. No Face ID.
- "email Amara the invoice" → "Email to Amara ready" with Send and Edit. Send asks for Face ID.
- "send 5000 NEAR to stranger.testnet" → a Blocked card. No approval card is ever sent for it.

**2. Without the app (picture cards).** Just text Penny. Tap the setup link: your browser makes an approval key and a passkey behind Face ID. Cards arrive as picture links; tap one, then Approve with Face ID on the page. Penny checks the passkey on its server, sends the move, and sends a fresh card showing Sent or Blocked.

Text **freeze** any time (or tap Not me on a Blocked card, which asks you to confirm first): every key Penny trusts for you is switched off and every open card is cancelled. Text **unfreeze** to start again: Penny sends an Unfreeze card, and only Face ID on it (with the key that was switched off) turns your keys back on. A text alone never does.

Testnet only for now (`NEAR_NETWORK=testnet`). Proof of the approval path: `bun run prove`, results in `PROOF.md`.

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

### Run the testnet proof

`bun run prove` with no settings runs every check against an in-process engine (fake chain, no transactions). For the real proof against a deployed testnet engine, set on the engine `NEAR_NETWORK=testnet`, `DRY_RUN=0`, the testnet relayer keys and `PENNY_PROVE_SECRET`, then run locally with `PUBLIC_BASE_URL`, `PENNY_PROVE_SECRET`, `PENNY_PROVE_ACCOUNT_ID` (a funded `*.testnet` account) and `PENNY_PROVE_PRIVATE_KEY` (its test key). The proof routes are off unless the secret is set and the engine refuses to boot with it on mainnet.

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

## Libraries

Bun · TypeScript · Hono · Drizzle ORM · Postgres (Neon) and PGlite with pgvector · zod · Vercel AI SDK · NEAR AI Cloud · `@near-js/*` · `@noble/curves` and `@noble/hashes` · Photon Spectrum (`spectrum-ts`, `@spectrum-ts/imessage`) · `@simplewebauthn/server` and `@simplewebauthn/browser` · `@resvg/resvg-js` · Composio · Langfuse · pino · ulid · `@phala/dcap-qvl` · React and Vite · Biome · Geist fonts (SIL OFL) · iOS: SwiftUI, CryptoKit, LocalAuthentication, Messages, App Attest, XcodeGen.

## About this code

Much of this code was written with AI coding agents, under human review: every change is a pull request with tests, checked by CI (typecheck, tests, Biome, gitleaks).

Code counts from 19 Oct 2026.

## License

MIT. See `LICENSE`.
