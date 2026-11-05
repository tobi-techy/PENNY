# Penny: the idea

> Your money crew in iMessage. Text it like a friend, approve with Face ID, done.

Status: being built for the NEAR Hackathon (dev window 1 to 14 Nov 2026). This doc explains what Penny is, why it exists, how it works and what is planned. It is the "why and what". `DESIGN.md` is the "how it looks and feels". `ARCHITECTURE.md` and `SECURITY.md` are the binding technical contracts.

---

## 1. The problem

Managing money well takes a dozen apps and a lot of attention:

- An exchange to buy, a bridge to move, a wallet to sign, a bank app to pay bills, a spreadsheet to track.
- Every crypto move asks you to pick a chain, a token, a route and a gas setting.
- AI "agents" that promise to handle this usually want your keys or a blank cheque. You either trust a bot with everything or you do it all yourself.

Most people already live in one app all day: Messages. They text friends "send me $20" and "did you pay DStv?". Money talk already happens there. The tools to act on it do not.

## 2. The pitch

Penny is a crew of AI agents that runs your money from iMessage.

You text in plain words:

- "put $50 somewhere safer"
- "pay my DStv"
- "send ada $20 for lunch"
- "split dinner with kemi and tolu"
- "make me a bot that runs my X"

The crew works it out. Invest builds a portfolio, Mail finds the bill, Guard checks your limits. Every move lands in your thread as a live card. Nothing happens until you approve it with Face ID on your own phone. Your keys never leave your iPhone.

One line: **text a belief, get a portfolio. Text a chore, get it done. Your phone holds the keys.**

## 3. Who it is for

- Gen Z and young professionals who hold some crypto and some fiat, and want them to work without becoming a full-time trader.
- People in markets like Nigeria where dollar savings, cross-border payments and bill payment are daily needs.
- Anyone who wants an agent that can act, without handing over custody.

## 4. How it works (the 30-second version)

1. You text Penny's number in iMessage.
2. Penny (the lead agent) reads it and hands it to the right crew member.
3. That agent turns your words into a typed plan: what, how much, to whom, by which route.
4. Guard checks the plan against your rules: caps, allowlist, new recipients, quote freshness.
5. Penny replies with one short line and a live card in the thread.
6. You tap "Approve with Face ID". Your iPhone signs the move with a key only it holds.
7. Penny relays it on NEAR, edits the same card through each step, then shows the receipt.

## 5. The crew

Each agent has its own NEAR sub-account, its own soul (personality file), its own tools and its own limits.

| Agent | Shape | Job | Can move money |
|---|---|---|---|
| **Penny** | lowercase p | Lead. Talks to you, routes work, keeps memory, runs the weekly reflection. | Only through other agents' plans |
| **Invest** | triangle | Turns a belief or goal into a portfolio. Uses Glider portfolios on EVM and Solana, funded via NEAR Intents. | Yes, with Face ID |
| **Guard** | shield | Your limits. Checks every plan before a card is shown. Says no calmly. | Never. It only blocks or allows. |
| **Mail** | envelope | Reads your inbox (read-only) for bills, receipts and refunds. | Proposes bill payments, you approve |
| **Finance** | squircle | Watches spending, sends the Sunday check-in, spots patterns. | Never. Read-only. |
| **Errand** | pink | Paid personal tasks and splits with friends. | Yes, with Face ID |

### Custom bots (user-created)

You can make your own crew members by text. Examples: an X manager that drafts and schedules posts, a technical bot that watches your GitHub, a savings bot that rounds up.

- "make me a bot that runs my X" → Penny drafts a name, a soul and a tool list, then sends a "New bot" card.
- Bots are data, not code: a soul file, a set of tools from a registry, and permissions.
- Every tool has a risk level: read, write or money.
- A bot with only read tools goes live after a plain confirm.
- A bot that can post or act (write tools) needs Face ID to create.
- A custom bot can never touch money unless you give it a cap, and that also needs Face ID.

## 6. The soul

Penny should feel like someone, not a form. Each agent has:

- **A SOUL.md**: who it is, what it values, how it talks, what it refuses. Penny is warm and a bit cheeky and texts in lowercase. Invest is curious and opinionated and admits when it is unsure. Guard is dry and calm.
- **Visible thinking**: one line before a move ("checking your cap first…"), and short crew debates when it matters ("Invest: ETH looks strong. Guard: you're at $38 of $100 this week.").
- **Moods**: idle, thinking, win, wink, blocked, paused, done. They are set by events, not invented. They change the wording, the tapbacks and the card art.
- **Memory**: private memory of your preferences, people and patterns, stored on our backend, with inference on NEAR AI Cloud.
- **Reflection**: every Sunday Penny reviews the week, tells you what it learned and logs any change to its soul in a changelog you can read.

Two hard rules:

1. **Mood never touches money.** Rules, caps and approvals are deterministic code. A "happy" Penny cannot approve anything.
2. **We are honest.** The feelings are simulated personality, and Penny says so if asked.

## 7. Example flows

### Invest
> you: put $50 somewhere safer
> penny: got you. invest has an idea 👀
> [Pick a portfolio card: Calm ETH Momentum, Balanced Majors, Bold SOL Memes]
> you: tap Balanced Majors
> [Invest card: BUY · $50.00 · Balanced Majors · quote 0:28 · Approve with Face ID]
> Face ID → Approving… → Approved → steps tick (quote, Guard, swap via Intents, deposit) → View order

### Pay a bill
> mail: your DStv bill is in. $18.40, due friday.
> [Bill card · Pay $18.40 · Approve with Face ID]

### Send
> you: send ada $20 for lunch
> [Send card · $20.00 to Ada · arrives in ~2s · Approve with Face ID]

### Split
> you: split dinner $42 with kemi and tolu
> [Split card · $14 each · Nudge] (no Face ID, nothing leaves your wallet)

### Guard says no
> you: send $900 to 0x9f…
> [Guard card, red · "New address and over your $200 cap" · Not me / Allow once]

### Weekly check-in
> [Weekly card, mint · "You spent $212 this week, $40 less than last" · read-only]

### New bot
> you: make me a bot that runs my X
> [New bot card · "Poster" · tools: draft, schedule, post · Create with Face ID]

## 8. Why NEAR

- **Accounts that read like names**: `invest.tobi.penny.near` instead of a hex address. Each agent is a real sub-account.
- **Keys with scopes**: function-call access keys let an agent call specific contracts with a gas allowance and no power to drain funds.
- **Meta-transactions (NEP-366)**: your iPhone signs, our relayer pays gas. You never need NEAR for fees.
- **NEAR Intents (1Click)**: one call to move value across chains, so Invest can fund Glider portfolios on Base or Solana from USDC on NEAR.
- **NEAR AI Cloud**: OpenAI-compatible inference for the crew, with a privacy story.

## 9. Safety model in one paragraph

Penny is non-custodial. Your only full-access NEAR key is created on your iPhone, stored in the Keychain behind Face ID and never exported. Every money move is a delegate action your phone signs after Face ID. The backend holds no user keys and agent accounts hold no user funds. The AI only fills typed plans; deterministic code builds the transaction; Guard checks policy; the server verifies your signed action matches the approved plan byte for byte before relaying. Details: `SECURITY.md`.

## 10. Hackathon tracks

Swarms (a crew of agents that debate and hand off), Agents (acting on your behalf), DeFi (Intents + Glider portfolios), Privacy (non-custodial keys, private memory, NEAR AI Cloud inference).

## 11. Scope and plan

### Must ship by 14 Nov
- iMessage line via Photon, Penny replying with soul and moods.
- Penny iMessage extension: the live card in its four states, Face ID signing on device.
- Engine: router, Guard, approvals, webhook, relayer.
- One real money path end to end on mainnet with tiny amounts (Invest via Intents, or Send).
- Device enrollment.
- Custom bot creation (one demo bot).
- README with "do X, see Y" steps, demo video, X post.

### Nice to have
- Mail read-only bill detection.
- Finance weekly check-in.
- Split requests.
- Sunday reflection with changelog.

### Later
- Group chats with friends' Pennys (agent-to-agent).
- Companion app beyond enrollment and settings.
- Undo windows for reversible moves.

### Day plan
| Date | Focus |
|---|---|
| 5 Nov | Contracts, card system, monorepo, engine/chain/iOS skeletons |
| 6 to 7 Nov | Sub-accounts, function-call keys, Intents dry runs, Photon echo bot |
| 8 to 9 Nov | Router, Invest, Guard, custom bots |
| 10 Nov | Approval path, card edits in place |
| 11 Nov | Mail (read-only), Finance |
| 12 Nov | Polish, live step edits |
| 13 Nov | Tiny mainnet run, README |
| 14 Nov | Demo video, X post, submit |

## 12. Open questions

- Which custom bot to demo (X manager is the current pick).
- Exact Glider ownership model for a user's portfolio address (being researched).
- Whether Photon polls are usable for the "Pick a portfolio" step, or a card does it.

## 13. Inspiration and credit

- Flip (heyflip.com), an iMessage money agent built on Photon: the reference for the in-thread approval card UX.
- Reflect (reflect.money): the reference for the card visual system.
- Photon Spectrum: the iMessage platform Penny runs on.
