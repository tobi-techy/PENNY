# PROOF

Run: `bun run prove` (scripts/prove.ts) · 2026-11-08T20:36:54.354Z

Mode: **local (in-process engine, fake chain, dry run: no transactions)**

| Check | Result | Detail | Link |
|---|---|---|---|
| TEE attestation | pass | mode=off verified=false (private mode off) | — |
| Send 0.1 NEAR settles | pass | status=settled (dry run: no transaction) | — |
| Reused signature is refused | pass | HTTP 409 not_pending | — |
| Over-limit send is blocked by Guard (no approval card) | pass | decision=block: That's $20,000.00, over your $50.00 per-payment limit. That would take you past your $100.00 daily limit. You have $99.60 left for the next 24 hours. | — |
| Wrong key is refused and the card expires | pass | HTTP 422, approval expired | — |

Overall: **all green**

Local mode proves the server checks (challenge, approval hash, device signature, reuse,
Guard before the card) but sends nothing on chain. The testnet proof needs a deployed
engine: see "Run the testnet proof" in README.md.
