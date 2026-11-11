# @penny/chain

NEAR accounts, NEP-366 delegate verification + relayer, NEAR Intents 1Click, Glider. Non-custodial: the server never holds a user key. **Dry run by default.** A broadcast needs `PENNY_ENV=mainnet` AND `DRY_RUN=0` AND a signer key AND the call-level request `{dryRun:false, env:'mainnet'}`. Dry runs never sign.

On testnet the test dollar (tUSD) takes USDC's place: `NEAR_USDC_CONTRACT` names the token every dollar action moves (an override is refused on mainnet). `PENNY_GUARD_CONTRACT` names the shared Guard contract; the engine checks the owner's allowance there before a money card and before relay. Unset means that check is off.

```
bun x tsc --noEmit -p .   # typecheck
bun test                  # 70 tests, all mocked (no network)
bun run scripts/smoke-readonly.ts   # mainnet read-only: RPC views + 1Click dry quotes
bun run scripts/bootstrap-agents.ts # DRY plan for invest/guard/mail/finance/errand.penny.near
```

| Module | What |
|---|---|
| `src/near/rpc.ts` | zod-validated JSON-RPC (view_account, view_access_key(_list), call_function, block, gas_price, send_tx). Unsafe JSON ints rejected. |
| `src/near/accounts.ts` | `AccountFactory.createUserAccount(slug, deviceKey)`: CreateAccount + Transfer(0.002 NEAR) + AddKey(device, FullAccess), then app-paid USDC `storage_deposit`. Slug rules + reserved names. `planAgentAccounts` (dry). |
| `src/near/delegate.ts` | `decodeSignedDelegateAction` (strict base64, canonical borsh round-trip) and `verifySignedDelegateAction` (sender, receiver, actions incl. args bytes == JCS(args), gas/deposit caps, ed25519 sig over sha256(prefix 2^30+366 ++ borsh), key on chain + FullAccess + optional enrolled-device match, nonce > on-chain and <= height*1e6, maxBlockHeight live and <= 600 ahead). |
| `src/near/relayer.ts` | `NearRelayer.relay(sda)`: outer tx relayer→sender with `[SignedDelegate]`; dry = would-be hash + preflight (keys, nonce, expiry, relayer balance, ft balance, receiver registration). Inner deposit cap 0.01 NEAR. |
| `src/near/chainsig.ts` | Read-only Chain Signatures EVM address derivation (`v1.signer`). |
| `src/intents/oneclick.ts` | `OneClickClient` getTokens / quote / status, echo check, floor-slippage bound, minReceived, expiry ≤120 s; `buildDepositActions` → `storage_deposit?` + `ft_transfer` to the deposit address. |
| `src/glider/client.ts` | Glider v2: whoami, strategies, discovery, portfolios, positions, enroll stage 1/2, start; `resolveDepositAddress`. |
| `src/adapter.ts` | `ChainAdapter` = engine `ChainPort` (verifyDelegateAction, relay, txStatus, createUserAccount, prepareSigning) + quoteInvest, buildInvestDeposit, getBalances; `chainAdapterFromEnv`. |

Canonical JSON is a local RFC 8785 copy; `test/canonical.test.ts` runs `packages/shared/test-vectors` against it as a drift guard.

See `docs/GLIDER-ADDRESS-OWNERSHIP.md` and `docs/CONTRACT-CHANGES.md`.
