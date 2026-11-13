# Penny on Concordium: accountability layer plan

Status: **plan plus a completed registration spike**. The four badges are live on testnet. Engine integration (`verify_agent`, passport pages) is not built yet. This document does not change `ARCHITECTURE.md` or `SECURITY.md`. If implementation would change either contract, propose that doc change first.

Hackathon: Concordium Trusted Agents (Encode Club), build window 19 Nov to 9 Dec 2026.
Decision: NEAR remains the money rail. Concordium is the identity and accountability rail.

## Spike result (13 Nov 2026)

The registration path is proven end to end on testnet.

Owner account: `3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT`, created by a headless identity and funded with 20,000 test CCD from the faucet.

| Agent | Token | Badge | Card SHA-256 |
|---|---|---|---|
| Penny | 1169 | `JyP9Wd81dn3JwiAs6agks` | `6f10957ecc9ab4dbbe8e0e85e49a76a0f55fd55ec794210fc9f0593c4633cb67` |
| Guard | 1170 | `JyP9WeDVZoYEmqQfdWWtd` | `073146dee5986e4e443e18c6e37571fb6a6479e44bd64ee7ac5e5bc0b707bdb5` |
| Invest | 1171 | `JyP9WfJyVq3AbxeVcM9Sp` | `e5ee628c0c87ed65b37e25217d456dd6ce05614399f090d9bac6d8f66a7113eb` |
| Mail | 1172 | `JyP9WgQTRrY6S5tFdiQi3` | `c817c8f3f8b4ba1d9c7679c82ae1770aa69581d3051ed2a8312906ddb2767bf9` |

Every badge returns `badge_valid: true` with zero issues, including `hash_matches_on_chain`, `owner_matches`, `verification_present`, and `verify_url_matches`. Public facts live in `config/concordium-agents.json`; the generated evidence is in `CONCORDIUM_PROOF.md`; the reproof command is `node scripts/concordium/verify.mjs`.

Two caveats:

- The cards are currently served from a temporary ngrok tunnel. Rebuild them against the repository URL and re-pin each hash before submission.
- CIS-8 is not bound yet because no operator NEAR key is present in this environment.

## 1. What we are building

Register the four core Penny agents (Penny, Guard, Invest, Mail) as native CIS-8004 agents on Concordium testnet, each with:

- a public Agent Card whose bytes are pinned on-chain by SHA-256
- a Verified by Concordium badge that anyone can resolve without trusting Penny
- a passport page that shows what the badge proves and what it does not

Bind Penny's operator NEAR key through CIS-8 so the Concordium agent and the NEAR operator account are provably the same operator.

Add `verify_agent` to the engine so Penny and Guard can check a counterparty's badge inside the conversation, and put the result on the approval card the user already sees.

Nothing in the money path changes. No user key, user fund, or settlement step moves to Concordium.

## 2. Non-goals

- Do not migrate NEAR payments to Concordium.
- Do not rebuild Penny as a Concordium dApp.
- Do not build a parallel toy agent.
- Do not claim EU AI Act compliance or production regulatory readiness.
- Do not claim every built-in agent has its own funded NEAR account. The architecture specifies per-agent sub-accounts and engine-held keys; the current seeding path does not populate `bots.nearSubAccount`, so the CIS-8 binding uses the operator app key. If we run the per-agent bootstrap, update this document and the claim at the same time.
- Do not call the testnet identity a verified human. It is a testnet credential. Production uses a production ID provider.

## 3. Network facts

| Item | Testnet | Mainnet |
|---|---|---|
| CIS-8004 Agent Registry | `<12802,0>` | `<10082,0>` |
| CIS-8 External Key Registry | `<12801,0>` | `<10081,0>` |
| Chain id (CAIP-2) | `ccd:4221332d34e1694168c2a0c0b3fd0f27` | `ccd:9dd9ca4d19e9393877d2c44b70f89acb` |
| Explorer | `https://ccdexplorer.io/testnet` | `https://ccdexplorer.io` |
| Registry dashboard | `https://testnet-agent-registry.concordium.com/dashboard` | `https://agent-registry.concordium.com/dashboard` |
| Registry API | `https://agent-registry-api.testnet.concordium.com` | `https://agent-registry-api.mainnet.concordium.software` |

Testnet genesis hash: `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`.

Testnet module references, for independent verification:

- CIS-8004: `0e57473715d1c2a364fa626b8783688db32b7fac9d0e2fc97043da91e1a7d3eb`
- CIS-8: `3236c12fade1b559935906df2e0e43a372234eac5d40599d6e6cb12cdd6b9afd`

Testnet admin account for the canonical instances: `3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8`.

Do not deploy our own registry instance. Use the canonical instances so the badges resolve in the public dashboard and the submission's explorer links point at real, shared infrastructure.

## 4. Badge mechanics

The badge string is the agent's CIS-2 token address, Base58Check encoded:

```
Base58Check(0x02 || ULEB128(contract_index) || ULEB128(subindex) || 8-byte LE token_id)
```

Example shape: `JyP9YQ12p23Tk9iFqSYa8` for `<12802,0>` token 1007.

Verification is trustless:

1. Parse the badge to the contract and token id.
2. Confirm the contract implements CIS-8004.
3. `agent_of(token_id)` returns a record with `status = "Active"`.
4. Fetch `agent_uri`, SHA-256 the **served bytes**, compare to the on-chain `metadata_hash`.
5. Optionally check the CIS-8 key binding.

The Agent Card carries the badge as an A2A extension:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://docs.concordium.com/a2a-extensions/concordium-badge/v1",
        "required": false,
        "params": {
          "tokenAddress": "<badge>",
          "owner": { "account": "ccd:<chain>:<account>" },
          "contracts": { "cis8004": "12802.0", "cis8": "12801.0" },
          "verify": "https://agent-registry-mcp.concordium.com/v1/check-badge/<badge>",
          "verification": {
            "service": "concordium-agent-registry",
            "verifyUrl": "https://agent-registry-mcp.concordium.com/v1/check-badge/<badge>",
            "mcp": "https://agent-registry-mcp.concordium.com/mcp",
            "docs": "https://docs.concordium.com/"
          }
        }
      }
    ]
  },
  "registrations": [
    { "agentId": "<token_id>", "agentRegistry": "ccd:<chain>:12802.0" }
  ]
}
```

The `verification` block is required for `verification_present: true` in `check_badge`. Cards without it can still be `badge_valid`, but the submission should show both true. Include it.

## 5. Registration runbook

The official registry UI currently generates a random `metadata_hash` instead of hashing the card at the metadata URL. Registering a real card through the UI therefore pins a hash that will not match `hash_matches_on_chain`. Use the MCP builders and a script, and verify the result. See section 12.

### 5.1 One-time owner account

Create a testnet owner account with a headless identity flow, or import a seed from a browser wallet. The script owns the seed locally; the seed never enters the engine runtime, the repo, or a card.

1. Generate or load a 24-word seed.
2. Derive the Concordium account key with `@concordium/web-sdk` (`ConcordiumHdWallet.fromHex(seed, 'Testnet')`).
3. Issue a testnet identity through the wallet proxy v0 flow, deploy the initial credential, and wait for finalization.
4. Fund the account from the testnet faucet (`PUT https://wallet-proxy.testnet.concordium.com/v0/testnetGTUDrop/<address>`). The faucet gives 20,000 CCD, far more than four registrations and pins need.
5. Write the account address and seed to a gitignored state file with mode `0600`.

If headless identity issuance is unavailable or flaky, fall back to exporting a seed from the browser wallet. Do not fall back to UI registration for a card with a real hash.

### 5.2 Per-agent registration

For each agent, in order: Penny, Guard, Invest, Mail.

1. `build_register` with `network`, `sender`, `agent_uri: null`, `metadata_hash_hex: null`, `initial_metadata: []`.
2. Sign and submit. Wait for finalization. Record the transaction hash.
3. Resolve the new token id from the indexer (`/agents?owner=<account>`) or from the register transaction events (`fe|f0|f5` followed by the 8-byte little-endian token id).
4. Compute the badge string from `<12802,0>` and the token id.
5. `build_agent_card` with the token id, name, description, skills, owner account, and card URL. The result includes the badge extension and a `metadata_hash_hex`.
6. Post-process deterministically: add `type`, `image`, `active: true`, `x402Support: false`, `documentationUrl`. Do not add timestamps or random values.
7. Write the exact UTF-8 bytes to `agents/<slug>/agent-card.json`. Compute SHA-256 locally. This is the hash that must be pinned.
8. Host the file. For the hackathon, `https://raw.githubusercontent.com/tobi-techy/PENNY/main/agents/<slug>/agent-card.json` is the `agent_uri`. The engine also serves the same bytes at `/agents/<slug>/agent-card.json` for production.
9. Fetch the hosted URL and confirm the served SHA-256 equals the local hash. Do not pin a hash you have not seen served.
10. `build_set_agent_uri` with the token id, `agent_uri`, `metadata_hash_hex`, and sender. The web-sdk `setAgentURI` parameter uses the double-nested newtype shape `{ Some: [[...32 bytes]] }`. Sign, submit, wait.
11. `check-badge` on the badge. Require `badge_valid`, `status_active`, `hash_matches_on_chain`, `owner_matches`, `extension_conformant`, `contracts_match`, and `verification_present`.
12. Append the public facts to `config/concordium-agents.json`: slug, name, token id, badge, owner account, card URL, card SHA-256, register tx, pin tx, network, timestamps.

The script is idempotent. It reads the state file first, skips an agent whose card hash and badge already verify, and only re-pins when the card bytes change. Re-pinning is a new transaction; never re-register an agent to change its card.

### 5.3 Penny CIS-8 binding, operator NEAR key

Bind the NEAR key that the engine actually uses as its operator/app account. Do not bind a user key.

1. Read `NEAR_APP_PRIVATE_KEY` locally in the ops script. Derive the ed25519 public key. Do not print the private key.
2. `build_cis8_canonical_bytes` with `network`, `concordium_account=<owner>`, `external_namespace=near:testnet`, `external_key_namespace=near:testnet`, `external_key_type=ed25519`, `external_public_key_hex=<32-byte hex>`, `proof_scheme=solana-ed25519`.
3. Sign the canonical bytes with the NEAR ed25519 key. Submit the signature hex.
4. `build_cis8_register` with the key, proof, and sender. Sign and submit.
5. `build_set_external_reference` on the Penny agent token with `kind: Cis8`, the CIS-8 contract `<12801,0>`, and the key fields. Sign and submit.
6. Rebuild the Penny card so it carries the external reference, re-host, and re-pin.
7. Verify `owner_of_key` and `agent_by_external_reference` both point to Penny.

Use `near:testnet` while the engine runs NEAR testnet. Production changes to `near:mainnet` and re-binds the production operator key. The registry chain catalogue lists `near:mainnet` with key type `ed25519` and proof scheme `solana-ed25519`; NEAR is a first-class ecosystem there, not a workaround.

## 6. Engine integration

New package: `packages/concordium`.

- `card.ts`: deterministic Agent Card builder, skills map, canonical JSON, SHA-256.
- `client.ts`: MCP REST client for `check-badge`, `verify-agent-card`, `get-badge-JSON`. 5 second timeout, one retry on 429 with `Retry-After`, zod-validated responses, 60 second in-memory cache.
- `verify.ts`: turns the raw checks into a verdict: `verified | invalid | revoked | unknown | unavailable`.
- Tests: card determinism, hash stability, extension shape, verdict mapping, timeout, 429, malformed JSON, cache expiry.

Engine surface:

- `verify_agent` tool in `apps/engine/src/brain/registry.ts`. Input `{ badge?, agentUri?, account? }`, one of them required. Risk `read`. No Face ID. Added to Penny and Guard, and to any built-in that can talk to a counterparty. It never moves money.
- Policy: add `verify_agent: false` to `APPROVAL_POLICY` in `apps/engine/src/cards/policy.ts`.
- Tool behavior: if the MCP is unavailable, return `unavailable` and say so. Never say "verified" without a check.
- Passport pages: `GET /agents/:slug` and `GET /agents/:slug/card.png`, plus `GET /agents` index and `GET /.well-known/agent-card.json` for Penny. HTML inline like the existing `/a/:token` pages, Penny brand `#111519`, no React. Public, no PII, `noindex` optional because these should be discoverable.
- Card facts: when a counterparty badge is supplied, add `{ label: "Accountability", value: "verified by concordium · <badge>" }` to `approval.facts`. Do not add the badge to `IntentPlan`; `planHash` and the test vectors stay unchanged.
- `concordium_checks` table, phase 2: append-only log of subject, badge, network, verdict, checks, owner, card URL, checked at. No migration in phase 1. `approval_events` already records the approval side.

Environment additions, all optional with safe defaults so the engine still boots without them:

```
CONCORDIUM_VERIFY=off            # on for the testnet demo
CONCORDIUM_MCP_URL=https://agent-registry-mcp.concordium.com
CONCORDIUM_AGENTS_CONFIG=config/concordium-agents.json
```

The owner seed and NEAR private key are ops-script only. They are not read by the engine.

## 7. Agent Cards and passport pages

Each card is one document valid as an ERC-8004 registration file and an A2A v1 Agent Card. Required fields:

- `type`: `https://eips.ethereum.org/EIPS/eip-8004#registration-v1`
- `name`, `description`, `image`, `active`, `x402Support: false`
- `services`: only real endpoints. Omit if there is no public service.
- `skills`: product-level, stable ids. No internal prompts, no soul text, no user data.
- `registrations`: token id and `ccd:<chain>:12802.0`
- `capabilities.extensions`: the Concordium badge extension with the `verification` block

Suggested skills:

| Agent | Skills |
|---|---|
| Penny | send money, check balances, split a bill, remember a preference, route to the crew |
| Guard | check a spend against policy, explain a block, recall past decisions |
| Invest | quote a swap, invest, review a portfolio, sell |
| Mail | read mail, draft a reply, send a draft |

Every skill id must map to a real tool or a real product capability before the card is published. Add a test for that mapping.

Passport page content:

- agent name, role, one-line description
- badge string, owner account, network, status
- "Check this badge" link to the MCP `verifyUrl`
- "Agent Card" link to the pinned bytes
- CCDExplorer link for the registration and pin transactions
- skills list
- a box titled "What this proves" and one titled "What this does not prove"

"What this proves": a Concordium account owns this agent, the agent is active, the card served at this URL hashes to the on-chain record, and the badge was issued by the canonical registry.

"What this does not prove": that the agent is honest, that its output is correct, that a testnet identity is a real person, or that the agent complies with the EU AI Act.

Do not use the official Concordium logomark unless the brand asset is cleared for this use. Text plus a link is enough.

## 8. Verification flow in the conversation

Demo flow:

1. User: "check amara's agent before I pay her."
2. Penny calls `verify_agent` with the badge or card URL.
3. Penny replies with the verdict and the evidence: owner, active, card hash matches, checked just now.
4. If the verdict is `invalid` or `revoked`, Penny says so and does not offer to send.
5. If the verdict is `unavailable`, Penny says it could not check and links the raw `verifyUrl`.

Phase 1 is informational. Phase 2, if time: when a badge is explicitly claimed for a counterparty, block an approval on `invalid` or `revoked`, and warn but allow on `unavailable`. The badge is not a security control for the user's funds; the NEAR recipient and Face ID still are.

## 9. Privacy and security boundaries

- No user key, seed, or private key goes to Concordium, the MCP service, logs, or a card.
- The owner seed lives in a local gitignored file with mode `0600`. The engine never reads it.
- The Agent Card contains only public product facts: name, role, skills, owner account, badge, links. No user names, handles, balances, messages, or memories.
- The passport page is public and contains no PII.
- `verify_agent` is read-only. It cannot move money, change permissions, or write to the registry.
- The MCP service holds no keys. All builder calls return sign-ready payloads that the ops script signs locally.
- Logs record badge, verdict, latency, and error code. Never the full response body at info, never a signature, never a seed.
- Do not pin a card containing a timestamp, a random nonce, or a build id. The hash must be reproducible.

## 10. Demo script, 3 minutes

| Time | Beat |
|---|---|
| 0:00 to 0:10 | Penny is a crew in iMessage that already moves money. The missing piece is proof of who is accountable. |
| 0:10 to 0:35 | Text: "send $25 to amara.testnet for the tap fix." Penny routes, Guard checks limits, the card appears. |
| 0:35 to 1:00 | Face ID. The card flips to Sent. Show the NearBlocks testnet receipt. The key never left the phone. |
| 1:00 to 1:25 | Text: "who's behind you?" Penny sends the passport link. Show Penny, Guard, Invest, Mail, badge strings, owner account. |
| 1:25 to 1:50 | Open the MCP `check-badge` result. Show `badge_valid: true`, `owner_matches`, `hash_matches_on_chain`. |
| 1:50 to 2:20 | Text: "check amara's agent before I pay her." Penny calls `verify_agent` and returns the verdict in the thread. |
| 2:20 to 2:40 | Architecture: NEAR is the money rail, Concordium is the accountability rail. One owner, four agents. |
| 2:40 to 3:00 | Production path: mainnet owner identity, mainnet registry, badge check before deals, grants programme. |

Record a backup take. Do not rely on live model latency for the money card; pre-warm the conversation and keep the prompts short.

## 11. Path to production paragraph

Penny already runs a multi-agent crew in iMessage with non-custodial NEAR accounts, Face ID approvals, Guard spending limits, and TEE-attested inference. This build adds Concordium as the accountability rail: four core agents are registered in CIS-8004 on Concordium testnet, each with a public Agent Card and a Verified by Concordium badge that any counterparty can resolve on-chain or through the Agent Registry MCP service. Production means one mainnet owner account created with a production Concordium identity, the same cards pinned to `<10082,0>`, and a badge check before any agent-to-agent deal. NEAR remains the settlement rail; no user funds or keys move to Concordium. The remaining work is operational: a mainnet registration run, key management for the owner account, resolver monitoring, and a policy that blocks a false badge claim. We will not claim EU AI Act compliance; the append-only approval and Guard records are designed to support Article 12 record-keeping, and we will map them with counsel before making that claim.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Registry UI pins a random metadata hash | Do not register cards through the UI. Use the MCP builders and the script. If a UI demo is required, set the hidden `metadataHashHex` to the real SHA-256 before Sign and Register. |
| Headless identity issuance fails | Fall back to a browser wallet seed. Keep the script as the only registration path. Ask at Workshop 6 or office hours for the recommended programmatic flow. |
| Card hash mismatch after hosting | Fetch the served bytes and hash them. Pin only the hash you observed. Re-run `verify_agent_card` after pinning. |
| MCP rate limits or downtime | 5 second timeout, one retry on 429, 60 second cache, `unavailable` verdict. The passport page shows the raw verify link when the check fails. |
| Indexer `/cis8/keys` returns a blank record | Do not depend on it. Use `owner_of_key`, `agent_by_external_reference`, and the canonical bytes builder. |
| Testnet reset | Keep the seed and state file. Re-registration is four registrations and four pins, minutes of work. Do not delete the state file. |
| Token id resolution | Prefer the indexer owner query. Fall back to register transaction events. Record the token id in the state file immediately. |
| Card hosting is not production-grade | GitHub raw is the hackathon URI. The engine `/agents` route is the production path. Both serve the same bytes. |
| Overclaiming | The passport page states what the badge proves and does not prove. The submission says testnet identity is a test credential. |

## 13. Timeline

| Dates | Work |
|---|---|
| 13 to 18 Nov | Registration spike: owner account, Penny registration, card hosting, pin, one clean `badge_valid: true`. |
| 19 to 25 Nov | `packages/concordium`, `verify_agent`, passport pages, tests. Register Guard, Invest, Mail. Checkpoint 1 on 22 Nov. |
| 26 Nov to 2 Dec | Badge facts on approval cards, `concordium_checks` if time, demo script, backup recording. |
| 3 to 9 Dec | `CONCORDIUM_PROOF.md`, submission text, production paragraph, buffer. Submit early. |

## 14. Definition of done

- Four agents registered on canonical testnet `<12802,0>`.
- Four badges return `badge_valid: true`, `status_active: true`, `hash_matches_on_chain: true`, `owner_matches: true`, `verification_present: true`.
- Four Agent Cards publicly resolvable and byte-identical to the on-chain hash.
- Penny's operator NEAR key bound through CIS-8 and resolvable back to Penny.
- `verify_agent` works in the iMessage thread and returns a verdict with evidence.
- The existing Penny money flow is unchanged: Guard, Face ID, NEP-366, relayer, NearBlocks receipt.
- `CONCORDIUM_PROOF.md` lists every badge, card hash, owner, and transaction link.
- The submission states which Concordium components are used and includes the production paragraph.
- No secrets, user data, or private keys in the repo, the cards, or the logs.
