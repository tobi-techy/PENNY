# Glider: who owns the portfolio? (finding, 5 Nov 2026)

## What Glider requires (verified in docs)
- B2B API v2, `x-api-key`, backend only. Production `https://api.glider.fi/v2`, staging `https://staging-api.glider.fi/v2` (key from developers@glider.fi). Source: https://docs.glider.fi/quickstart, https://api.glider.fi/v2/openapi.json
- A portfolio is created by **two-stage enrollment**: `POST /v2/enroll/signature` returns a message; the **owner wallet** signs it (`ECDSA` = `personal_sign` of `message.raw`, or `ERC1271` = EIP-712 typed data for one chain, or a Solana tx); `POST /v2/enroll` echoes `flowId`, `accountIndex` (string), `agentAccountId` byte-for-byte plus the signature. Owner id must be chain-agnostic `eip155:0:<addr>`. Source: https://docs.glider.fi/guides/two-stage-enrollment
- "An API key cannot replace a user signature." Withdrawals need a fresh owner signature (expires 10 min). Source: https://docs.glider.fi/guides/b2b-overview, quickstart §5
- Funding has no API: transfer the asset on-chain to the portfolio smart account (`depositAccountId` if present). Source: https://docs.glider.fi/guides/portfolio-deposit
- Chains: EVM (per-deployment list) and Solana (tenant entitlement `svm_b2b_api`). No NEAR.

So the user needs an EVM (or Solana) owner key. Penny's rule is "server holds no user keys", so the engine must not mint one.

## Recommended path: NEAR Chain Signatures owner
The owner EVM address is derived from the user's own NEAR account via the MPC contract `v1.signer` (mainnet) at a dedicated path `penny-glider-owner-1`. Only `<slug>.penny.near` can request signatures for it, and that account's only full-access key is the iPhone key. Source: https://docs.near.org/chain-abstraction/chain-signatures, https://docs.near.org/chain-abstraction/chain-signatures/implementation

Verified live (read-only): `v1.signer.derived_public_key({path, predecessor, domain_id:0})` returns a secp256k1 key; `src/near/chainsig.ts` turns it into the address (penny.near → `0xE7f27180c3a48CAcF569208Da6b22b0f3460F1FD`). 1Click accepted that address as a Base USDC recipient in a dry quote.

Flow:
1. Engine: `deriveEvmAddress(user)` → `ownerAccountId = eip155:0:<addr>` → `glider.prepareEnrollment`.
2. Engine: hash = EIP-191 `personal_sign` digest of `message.raw`; builds an Approval whose action is `FunctionCall v1.signer.sign { request: { payload_v2: { Ecdsa: <hex> }, path, domain_id: 0 } }` (receiver `v1.signer`).
3. Device: Face ID, signs the NEP-366 delegate. Relayer relays. MPC returns `{big_r, s, recovery_id}` in the tx outcome; engine assembles the 65-byte sig and calls `glider.enroll`.
4. Funding: 1Click quote USDC(NEAR) → USDC(Base), `recipient` = portfolio smart account; user signs the `ft_transfer` delegate. Same for each top-up.
5. Withdrawals: same MPC signing for the Glider withdraw authorization.

## Honest caveats
- Not run end-to-end: we have no Glider key yet, and the exact `sign` argument JSON and `SIGN_DEPOSIT_YOCTONEAR` must be checked against https://github.com/near/mpc (contract `src/api/sign.rs`) on testnet (`v1.signer-prod.testnet`) before mainnet.
- The relayer pays the attached deposit of inner actions, so the MPC fee comes out of the relayer.
- The device would sign an opaque hash. The card must say "Authorize Glider portfolio: <strategy>", and the engine must bind the hash to the stage-1 `flowId` it stored, then re-derive and compare before submitting.
- Trust: the key is held by the MPC threshold network, controlled by the user's NEAR key. That is non-custodial for Penny's server, but it is not "only on the phone".
- Exit gap: if a withdrawal lands on the owner EVM address on Base, moving it back needs an MPC-signed EVM tx plus ETH for gas on Base. Ask Glider whether the withdraw destination can be any address (e.g. a 1Click deposit address back to NEAR).

## Alternative (not recommended for v0.1)
Glider documents Privy, Turnkey and Para wallets. A passkey wallet on the device could be non-custodial, but it adds a second key system and vendor next to the NEAR key and breaks "one Face ID key rules everything".
