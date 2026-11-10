# PROOF

Run: `bun run prove` (scripts/prove.ts) · 2026-11-10T23:43:18.662Z

Mode: **remote, NEAR testnet, https://penny-tobi-omotade-2cd167ac.atlasflow.dev**

| Check | Result | Detail | Link |
|---|---|---|---|
| TEE attestation | pass | mode=enforce verified=true (private · verified in TEE) | — |
| Send 0.1 NEAR settles | pass | status=settled | [tx](https://testnet.nearblocks.io/txns/6fNp4hw3Z4EEBU9Wg3LXHkumBEGH3na6oDCkEPGukH92) |
| Reused signature is refused | pass | HTTP 409 not_pending | — |
| Over-limit send is blocked by Guard (no approval card) | pass | decision=block: That's $17,850.00, over your $50.00 per-payment limit. That would take you past your $100.00 daily limit. You have $99.64 left for the next 24 hours. | — |
| Wrong key is refused and the card expires | pass | HTTP 422, approval expired | — |

Overall: **all green**
