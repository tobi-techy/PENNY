# Penny — Trusted Agents submission

**Concordium Trusted Agents Hackathon**, Encode Club × Concordium.
Network: Concordium **testnet**. Submitted as: Penny, a non-custodial money crew in iMessage.

---

## 1. What we built

Penny is an AI agent crew that already moves real money in an iMessage thread: you text an ask, a specialist agent turns it into a typed plan, Guard applies spending limits, and the money only moves after Face ID on the user's iPhone. Every payment is a NEP-366 signed delegate action, so the user's key never leaves the device and Penny never takes custody.

That design has an obvious hole. Any agent can claim to act for a person. The service on the other side has no way to check whether an accountable human stands behind the agent in front of it.

This build adds that missing layer on Concordium, without moving Penny's money:

1. **Four agents registered** in the CIS-8004 Agent Registry, each with a public Agent Card whose bytes are hashed and pinned on chain.
2. **A Verified by Concordium badge** on each, resolvable on chain, over the Agent Registry MCP service, or from a plain HTTPS URL.
3. **Penny's identity bound across chains** through CIS-8, so the agent answers to the NEAR address it already uses.
4. **A badge check inside the conversation**, so Penny can verify a counterparty before it pays them.
5. **An x402 agent-payment path** on Concordium, with a self-hosted facilitator, a badge-gated paid endpoint, and a paying client.

The strategic line, stated plainly because it is the honest one: **NEAR is the money rail for users, Concordium is the accountability rail.** Face ID and signed delegate actions are what make Penny non-custodial, and no hackathon is a reason to rebuild a working settlement path. Concordium is where the question "who is accountable for this agent?" gets answered.

## 2. Which Concordium components we use

| Component | Where |
| --- | --- |
| **CIS-8004 Agent Registry** `<12802,0>` | Four agents registered, token ids 1169–1172 |
| **Verified by Concordium badge** | All four; `badge_valid: true`, verified live |
| **Agent Card / ERC-8004 format** | Served byte-identically to the on-chain SHA-256 anchor |
| **CIS-8 External Key Registry** `<12801,0>` | Penny's NEAR operator key bound, resolvable back to token 1169 |
| **Agent Registry MCP server** | `verify_agent` tool in the engine; the passport and proof scripts |
| **x402 payments** | Facilitator, badge-gated seller, paying client (see §5) |
| **Sponsored transactions** | The facilitator pays the network fee for an agent payment |

## 3. Evidence on CCDExplorer

Owner account: [`3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT`](https://ccdexplorer.io/testnet/account/3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT)

| Agent | Token | Badge | Register | Card pin |
| --- | --- | --- | --- | --- |
| Penny | 1169 | `JyP9Wd81dn3JwiAs6agks` | [6336cd40](https://ccdexplorer.io/testnet/transaction/6336cd403b406d1f2026d75bb619a5f167cbd1345318d4c64dc3d879c222b38b) | [3d52e2e2](https://ccdexplorer.io/testnet/transaction/3d52e2e26098cef61dd818892bf182cfb842a4a3b6e7f8c3668b5fbf7f6a06e4) |
| Guard | 1170 | `JyP9WeDVZoYEmqQfdWWtd` | [c48114d5](https://ccdexplorer.io/testnet/transaction/c48114d5e1cc4b378ecd7eb38b4c8de997c8f16ccfa3d9aa69054b0080c6d634) | [6d91db5c](https://ccdexplorer.io/testnet/transaction/6d91db5cad09a03de2a2da90506dcf9f797597d5105ec7694eab9799ca4a45af) |
| Invest | 1171 | `JyP9WfJyVq3AbxeVcM9Sp` | [4c8578f6](https://ccdexplorer.io/testnet/transaction/4c8578f65e304502c79d08567d4706f008378520205212acccf5da8c1573f6f7) | [27645688](https://ccdexplorer.io/testnet/transaction/276456886bc419defe58d7ec7ba899d35d3c3b4b3be394ac61989a0e6b889db2) |
| Mail | 1172 | `JyP9WgQTRrY6S5tFdiQi3` | [b9b681a5](https://ccdexplorer.io/testnet/transaction/b9b681a54ace7250183ebe752bab15be6114a381ae785f9b5e418c22481426eb) | [c917db85](https://ccdexplorer.io/testnet/transaction/c917db85fae9b4da692cb1571944f425141e67012dc1c1eed5f13600bda50c97) |

CIS-8 binding of the NEAR operator key:

- [`registerExternalKey` aece7c75](https://ccdexplorer.io/testnet/transaction/aece7c753e9f3ce20cadd88940f6d19cc89ba802bba57a36c0f8946638e1580d) — binds ed25519 `be83f8c7…617a`, metadata `near_account = penny-tobi.testnet`
- [`setExternalReference` 89053076](https://ccdexplorer.io/testnet/transaction/890530761e1b1194a37f71f27b8f4f3fec60dce2a5ab6f0412bde8a35c31c62c) — attaches the key to Penny's token 1169

Public passports: **https://penny-passport.vercel.app** — the crew index, one page per agent, and the pinned card bytes at `/agents/<slug>/agent-card.json`.

Verify any badge yourself:

```bash
curl -s "https://agent-registry-mcp.concordium.com/v1/check-badge/JyP9Wd81dn3JwiAs6agks?network=testnet" | jq .
```

## 4. What is unusual about this build

**The card bytes are the arrow of trust.** A card's SHA-256 is pinned on chain. Our passport route serves the file verbatim and **returns 503 rather than serve bytes that no longer match the pin**. A verifier that silently passes a changed card is worse than no verifier.

**The recorded evidence is audited, not asserted.** `CONCORDIUM_PROOF.md` is generated by a script that pulls the registry's own `URIUpdated` event log for each token and checks the recorded pin really is the latest, that the URI it carried is the configured URL, and that the hash it anchored is the configured hash. This caught a real stale hash in our own config, which had survived a re-pin.

**Identity is crossed, not duplicated.** CIS-8 means `penny-tobi.testnet` resolves to token 1169. A counterparty does not have to trust a website that says so.

**The seller refuses buyers.** In the x402 flow the *server* checks the *client's* badge before it will take money. The usual direction of trust is reversed, and an agent with no badge is turned away without being charged.

## 5. x402 agent payments — exact status

Built in `services/x402/`, outside the Bun workspace so `@concordium/web-sdk` 12 can coexist with the 9.2.0 pin the registration scripts depend on.

**Working and verified against the live testnet:**

- A **self-hosted facilitator** serving `/supported`, `/verify`, `/settle`. It announces `feePayer`, so a paying agent never needs CCD for gas.
- A **badge-gated seller**. `GET /guard/review` answers `402` with correct requirements — 500,000 atomic CCD, `payTo` resolved from Guard's on-chain `agentWallet` rather than a constant, `feePayer` set to the sponsor.
- The **badge gate**, observed refusing an unverified payer before any payment is processed, and failing closed when the registry is unreachable.
- A **paying client** that signs a sponsored transfer, enforces its own per-payment cap, and never broadcasts.

**Not yet settled.** Settlement returns `sponsor_as_sender`: x402's rule 9 requires the sponsor to be neither payer nor payee, and our testnet setup has one account acting as sponsor, payer and `payTo`. That is a provisioning gap, not a design one, and it needs three distinct funded accounts. Until it is closed we make no claim that a payment has settled.

We are stating this rather than showing a curated 402 and calling it a payment. `docs/CONCORDIUM-AGENT-PAYMENTS.md` carries the full design and the precise blocker.

## 6. Path to production

Production means one mainnet owner account created with a **production Concordium identity provider** (the testnet credential this build uses is a test artefact and is described as one), the same four cards pinned to mainnet `<10082,0>`, and mainnet `<10081,0>` for the key binding.

Concretely, what stands between this and real users:

1. **Mainnet registration run.** The scripts are already parameterised by network; this is an ops run, not new code.
2. **Owner key management.** The owner seed is currently a local file with `0600` permissions. Production needs it in an HSM or a managed signer, with rotation, and the registration scripts take only signatures so the operator key never has to live on the same machine.
3. **Resolver monitoring.** Badge checks sit in a payment path. A registry outage must degrade to "refuse and tell the user", never to "assume verified". That policy is implemented; it needs alerting.
4. **The three-account provisioning** described in §5, then a real settled agent-to-agent payment.
5. **A policy that blocks false badge claims.** A badge proves control of an owner account, not good behaviour. Penny must refuse a counterparty whose badge does not resolve, and say why.

On money: NEAR remains the settlement rail and no user funds or keys move to Concordium. Concordium carries identity, the cross-chain binding, and agent-to-agent payment for services.

On regulation: we do **not** claim EU AI Act compliance. Penny's append-only approval and Guard decision records are designed to support Article 12 record-keeping; we will map them with counsel before making that claim.

## 7. Honest limitations

- The x402 payment loop is proven to the point of settlement, not through it (§5).
- The seller is operated by us. It is genuinely open to any agent with a valid badge, but it is not an independent third party, and the submission does not pretend otherwise.
- Settlement is in test **CCD**, not a stablecoin. PLT testnet tokens require an issuer distribution that does not exist yet.
- The NEAR identity bound through CIS-8 is Penny's **relayer operator** account, not a user wallet. `near_account` is recorded on chain so this cannot be mistaken later.
- Nothing here has been audited.

## 8. Repository map

| Path | What it is |
| --- | --- |
| `packages/concordium` | Typed registry client: badge, owner, card verification, retry and cache |
| `apps/engine/src/passport/` | Public passport routes; serves pinned bytes or refuses |
| `apps/engine/src/brain/tools.ts` | `verify_agent` tool, available to Penny and Guard |
| `scripts/concordium/` | Register, pin, CIS-8 bind, export, verify |
| `services/x402/` | Facilitator, seller, paying client |
| `agents/<slug>/agent-card.json` | The pinned card bytes |
| `config/concordium-agents.json` | Public registry facts, no secrets |
| `CONCORDIUM_PROOF.md` | Generated proof, every check read back from chain |
| `docs/CONCORDIUM.md` | Runbook, network facts, boundaries |
| `docs/CONCORDIUM-AGENT-PAYMENTS.md` | x402 design and build status |
