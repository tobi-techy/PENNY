# Concordium agent payments

Status: **proposal, not built.** Nothing in this document is implemented yet.

## Why this exists

The hackathon judges on four things, and the first is the one that carries the most weight:

> **Depth of integration**: how meaningfully the project uses Concordium identity, the Agent Registry **and agent payments**.

Penny currently has two of those three, deeply. Identity is four live badges. The Agent Registry is CIS-8004 registration, pinned Agent Cards, public passports, and a `verify_agent` tool inside the conversation. Agent payments: **none.** All money moves on NEAR.

That strategic split was deliberate and is still right for the product. Face ID and NEP-366 delegate actions are what make Penny non-custodial, and no hackathon is a good reason to rebuild a working settlement rail. But the split leaves a visible hole against the stated rubric, and x402 appears in the brief three separate times, including as a core requirement: *"pay and get paid on its own."*

This document proposes closing that hole with a narrow, genuine payment path on Concordium, alongside NEAR rather than instead of it.

## What actually exists

Checked on 16 November 2026, not assumed.

| Fact | Detail |
| --- | --- |
| Package | `@x402/concordium`, latest **2.31.0**, Apache-2.0 |
| Provenance | Merged into the official x402 Foundation repository, PR #2390, 26 June 2026 |
| Roles | Client, server, **and facilitator** — all three are in the package |
| Scheme | x402 `exact`, with **V1 sponsored transactions** |
| Gas | The facilitator sponsors. The paying agent never needs CCD for fees |
| Assets | Native **CCD** (6dp), or PLT stablecoins (`EURR`, `USDR`, …) |
| Finality | Waits for ConcordiumBFT finalisation, ~10s |
| Testnet CAIP-2 | `ccd:4221332d34e1694168c2a0c0b3fd0f27` |
| Testnet gRPC | `grpc.testnet.concordium.com:20000` |
| An independent testnet facilitator is referenced in x402 discussion | `concordium-facilitator.onrender.com` — host resolves, but `/`, `/health` and `/supported` all return 404 as of 16 Nov 2026. Not usable. |

The important consequence: **we run the facilitator ourselves.** No external dependency, no waiting on anyone, no "our integration partner" caveat. The facilitator verifies 9 rules and then adds its own sponsor signature, so it can only ever sponsor the transfer it was asked to sponsor.

## Design

The whole idea in one line: **the Agent Registry says where to pay, the badge says who is paying, x402 actually moves the money.**

```
Penny (client)                    Guard's seller (server)              Facilitator
  │                                      │                                │
  │ 1. GET /guard/risk-report            │                                │
  │─────────────────────────────────────>│                                │
  │                                      │ look up Guard via CIS-8004     │
  │                                      │ payTo := Guard.agentWallet     │
  │ 2. 402 + PaymentRequirements         │                                │
  │<─────────────────────────────────────│                                │
  │                                      │                                │
  │ 3. sign sponsored transfer to payTo  │                                │
  │ 4. retry + PAYMENT-SIGNATURE         │                                │
  │─────────────────────────────────────>│                                │
  │                                      │ 5. verify caller's badge       │
  │                                      │ 6. verify(payload)             │
  │                                      │───────────────>│               │
  │                                      │                │ sponsor, submit,
  │                                      │                │ wait finalised
  │                                      │ 7. settled     │               │
  │                                      │<───────────────│               │
  │ 8. 200 + report                      │                                │
  │<─────────────────────────────────────│                                │
```

Three properties make this more than a checkout flow:

1. **`payTo` is not hardcoded.** It is read from the agent's on-chain `agentWallet` via CIS-8004 `getAgentWallet`. Change the registry entry and every client that resolves it pays the new address. The registry becomes the source of truth for where an agent gets paid.
2. **The seller checks the buyer's badge before charging.** That is the reverse of the usual flow, where you prove yourself to a bank. Here a machine checks whether a verified human stands behind the agent paying it, and refuses if not.
3. **The payer account and the checked badge are the same identity.** This is the claim worth making in the demo: on Concordium the payment sender is linked to a verified owner at account creation, so identity and payment are the same object rather than two records glued together afterwards.

### What Penny does with it

Penny's crew already has specialist agents. The flow that reads naturally to a real user:

> *"Penny, get Guard to look at that contract before I sign it."*

Penny knows Guard, resolves Guard's registered wallet, pays Guard's published price in CCD over x402, and returns the report. The user sees one sentence and one approval. The interesting part is happening underneath.

Keeping this honest: Penny and Guard are both ours, so a closed loop alone would be theatre. The seller should therefore be **open to any verified agent**, so a judge can point their own agent at it and watch it work. That turns a demo into a live service.

### Where NEAR stays

Unchanged. User money — sending, splitting, bill pay — stays on NEAR with Face ID and signed delegate actions. Concordium payments are for **agent-to-agent service payment**, a different flow with a different risk profile, and they say so plainly in the docs. We are not migrating settlement, and we will not claim to have.

## Technical constraints

These are the things that make this more than an afternoon, in order of annoyance.

1. **web-sdk version collision.** The repo pins `@concordium/web-sdk@9.2.0`; `@x402/concordium` requires `^12.0.0`. Bumping the root pin risks the working registration scripts. Plan: put the payment service outside the Bun workspace (`services/x402/`, since workspaces are only `packages/*` and `apps/*`) with its own `node_modules` and its own web-sdk 12.
2. **Bun cannot import the Concordium SDK.** Already known: the `bun` export condition points at TypeScript source. The existing registration scripts are `.mjs` on Node 24. The payment service inherits the same constraint: Node, not Bun.
3. **Testnet CCD, not stablecoin, for the first cut.** PLT testnet tokens (`EURR`) require a manual issuance request to Concordium through a form. CCD needs only the faucet we already used. Sponsored transactions mean gas is not the issue; the asset is. Start with CCD and say so.
4. **The facilitator needs a funded sponsor account.** The existing owner account works, and it already holds test CCD.
5. **Deterministic finality means ~10s per settlement.** Fine for a server-side call, too slow to sit inside a chat turn without a progress state.

## Build order

Each step is independently useful, so a partial build is still worth submitting.

1. **Facilitator, self-hosted.** Small service, our owner account as sponsor. Prove it settles a CCD transfer on testnet. ~half a day.
2. **One paid endpoint, badge-gated.** Guard's seller, with `payTo` resolved from the registry rather than configured. Prove the 402 → pay → 200 loop with `curl`. ~half a day.
3. **Penny as client.** A `risk: 'money'` tool in the engine, so it goes through Penny's existing approval path and appears in the conversation. ~a day.
4. **Surface it.** `x402Support: true` on the Agent Card (it is currently `false`), the paid endpoint advertised in the card, and the settlement linked from the passport page. ~hours.
5. **Set a real `agentWallet`.** Use CIS-8004 `setAgentWallet` with the 162-byte canonical signature so the payment address is a dedicated wallet rather than the owner account. This is the registry's own payment-routing primitive and it makes point 1 above real. ~half a day.

Steps 1–2 are the ones that turn the rubric from 2-of-3 into 3-of-3. Step 3 is what makes it a Penny feature rather than a demo.

## What we will not claim

- That Penny's **user** payments run on Concordium. They do not, and they will not before the deadline.
- That the seller is an independent third party. It is ours, and it will be described as ours. Its openness to any verified agent is real, the independence is not.
- That PLT stablecoin settlement is live. CCD only, until the issuer distribution exists.
- That per-agent NEAR accounts exist. Unchanged from the existing honesty note.
- That "sponsored transactions" means the user never touches gas in Penny's product. In the x402 flow the facilitator sponsors; in Penny's NEAR flows a relayer does. These are different mechanisms and will not be conflated.

## Cost of getting this wrong

The failure mode is a bolted-on payment demo that a judge reads as decorative — traffic in test tokens that proves a loop closed, not a payment. The defence is the coupling: the payment is only possible because the registry supplied the address and only permitted because the badge check passed. If a version of this can run with those two steps deleted, it is not deep enough.

## Build status, 16 Nov 2026

Built in `services/x402/`, outside the Bun workspace so it can carry `@concordium/web-sdk` 12 without disturbing the 9.2.0 pin the registration scripts depend on.

| Piece | State |
| --- | --- |
| Self-hosted facilitator (`src/facilitator.mjs`) | Working. Serves `/supported`, `/verify`, `/settle`, `/health`; announces `feePayer` = owner account |
| Badge-gated seller (`src/server.mjs`) | Working. Returns 402 for free, `payTo` resolved from Guard's on-chain `agentWallet`, refuses unverified buyers |
| Paying agent (`src/pay.mjs`) | Working up to settlement; see blocker below |
| Penny engine tool | Not built |
| Agent Card `x402Support` | Still `false` |

### What is proven

- The facilitator starts, registers `exact` on `ccd:4221332d…`, and reports `feePayer`.
- `GET /guard/review` answers **402** with a correct `PAYMENT-REQUIRED` header: 500,000 atomic CCD, `payTo` equal to Guard's registry `agentWallet`, `feePayer` equal to the sponsor.
- The badge gate refuses a payer with no badge **before** any payment is processed, and fails closed when the registry is unreachable. Both paths were observed live.
- The client builds and signs a sponsored transfer; it never holds CCD for gas.

### The blocker, precisely

Settlement is rejected with `sponsor_as_sender`. x402's rule 9 requires the sponsor to be neither the payer nor the payee, and this testnet setup has exactly **one** account: the owner is simultaneously sponsor, payer, and `payTo`. That is not a code defect; it is the single-account testnet artifact.

It cannot be worked around by config. Fixing it needs **three** distinct accounts: sponsor, payer, and Guard's payment wallet.

The clean way to create them without touching `.concordium/state.json` (which holds the identity and seed for all four registered agents, and must not be clobbered) is to run the existing account stage from a scratch working directory, since `STATE_DIR` is resolved from the process cwd:

```bash
mkdir -p /tmp/x402-sponsor && cd /tmp/x402-sponsor
node <repo>/scripts/concordium/register.mjs account   # writes ./.concordium/ here
```

Then point the service at the extra accounts:

```bash
PENNY_CONCORDIUM_SEED=/tmp/x402-sponsor/.concordium/seed.txt \
PENNY_X402_SPONSOR=<sponsor address> \
  node src/facilitator.mjs
```

and set Guard's `payTo` to the third account, ideally as a real CIS-8004 `setAgentWallet` (step 5 of the build order) so the payment address is genuinely the agent's rather than an override.

Each stage needs its own faucet drop. Until that is done, the loop is verified up to the point of settlement and no further.

### Attempted 16 Nov: two routes, both blocked

**Route 1 — new identities from a scratch directory. Fails at issuance.** `issueIdentity()` pins `ipIdentity === 0` in two places (`register.mjs:245`, and `deployCredential` around `:315`), and that provider is the one every account so far was issued under. On 16 Nov its host was intermittently unreachable:
`id-service.testnet.concordium.com` failed DNS (`ENOTFOUND`, `curl` code `000`) at first, then answered `500`. The two other testnet providers listed by `wallet-proxy/v1/ip_info` are alive — ipIdentity 3 (`concordium.staging.digitaltrustsolutions.nl/entry/v1/stg`) and ipIdentity 5 (`api.dataspike.io/api/concordium/testnet/identity`) — both answer `400` to a bare `GET`, which is the expected response for a POST endpoint. Using them means parameterising the provider (currently hardcoded) **and** completing that provider's own onboarding; Dataspike's flow expects an API key. Not attempted.

**Route 2 — extra credentials from the existing identity. Implemented, rejected by the network.** A Concordium identity can hold several accounts, and no identity provider is involved in deploying another credential, so this avoids the dead provider entirely. `scripts/concordium/register.mjs extra --cred 1` builds the credential from the seed already on disk plus `state.idObject`, deploys it, and funds it; results land under `state.extra` so the owner account in `state.json` is never touched.

It is rejected by the node with `RpcError: The credential deployment contained invalid signatures` (`SendBlockItem`, `INVALID_ARGUMENT`). Both plausible signing-key derivations were tried — `getAccountSigningKey(0, 0, 0)` and `getAccountSigningKey(0, credNumber, 0)` for `credNumber = 1` — and the node rejected each. The credential's declared `verifyKey` is masked as `*****` by the SDK, so the mismatch could not be read off directly. Unresolved; the stage is left in place because it is additive and correct as far as it goes, but it is **not** a working provisioning path and should not be described as one.

Practical consequence: the three-account setup is not available on testnet through the tooling in this repo today. A demo that must show a settled x402 payment needs either a working identity provider configuration or an account funded from outside this repo.


