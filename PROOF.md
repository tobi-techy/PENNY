# PROOF

Run: `bun run prove` (scripts/prove.ts) · 2026-11-10T23:48:36.633Z

Mode: **remote, NEAR testnet, https://penny-tobi-omotade-2cd167ac.atlasflow.dev**

| Check | Result | Detail | Link |
|---|---|---|---|
| TEE attestation | pass | mode=enforce verified=true (private · verified in TEE) | — |
| Send 0.1 NEAR settles | pass | status=settled | [tx](https://testnet.nearblocks.io/txns/6F6eTAyyQH9YdM82fUfDgm6cFgPZE2bC6FbV7RNy4kSD) |
| Reused signature is refused | pass | HTTP 409 not_pending | — |
| Over-limit send is blocked by Guard (no approval card) | pass | decision=block: That's $17,950.00, over your $50.00 per-payment limit. That would take you past your $100.00 daily limit. You have $98.93 left for the next 24 hours. | — |
| Wrong key is refused and the card expires | pass | HTTP 422, approval expired | — |

Overall: **all green**
