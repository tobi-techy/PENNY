# Invest

Text Penny "put $50 in SOL". Penny shows a preview, Guard checks your limits, you get a Face ID card, and after you approve, your USDC on NEAR is swapped into ETH, SOL or NEAR through NEAR Intents 1Click. The asset lands in your own NEAR Intents balance (inside `intents.near`, under your NEAR account). If the swap can't fill, 1Click refunds the USDC to your NEAR account.

## Flow

```
"put $50 in SOL"
  -> quote_invest      dry 1Click quote: est. out, rate, fee, min received, expiry (+ a Guard read). Nothing signed.
  -> propose_invest    Guard (limits) FIRST. Blocked = no quote, no card.
                       Firm (non-dry) 1Click quote -> deposit address, <=120 s.
                       Deterministic actions on USDC (17208628...36133a1):
                         storage_deposit(deposit address, 0.00125 NEAR)   only if not registered
                         ft_transfer(deposit address, amountIn, 1 yocto)
                       Guard again with the real quote, relayer ceiling check, then the Face ID card.
  -> Face ID           iPhone signs a NEP-366 delegate action over exactly those actions.
  -> submit            Guard again (mainnet per-tx AND daily caps clamped over your policy).
                       Quote expired?            -> old card "quote expired", fresh card. Nothing relayed.
                       Price beyond slippage?    -> old card "price moved", fresh card. Nothing relayed.
                       (fresh dry quote's estimate < the approved card's guaranteed minimum)
                       Byte-for-byte verify against the approval, relay with limit = approved deposit.
  -> after relay       POST /v0/deposit/submit (hint), then poll /v0/status by deposit address.
                       Card updates in place: "Sending…" -> "Buying now…" -> "Done" / "Refunded to you" /
                       "Didn't go through". Explorer links (explorer.near-intents.org, nearblocks.io) go to logs only.
```

Quote parameters: `swapType EXACT_INPUT`, `depositType ORIGIN_CHAIN`, `refundType ORIGIN_CHAIN`, `refundTo` = your NEAR account, `recipientType INTENTS`, `recipient` = your NEAR account, `slippageTolerance` = `INVEST_SLIPPAGE_BPS` (default 100 = 1%), `deadline` = now + 10 min. Every response is zod-validated and its echo (assets, amount, recipient, refundTo, slippage) must match what we sent; `minAmountOut` must sit inside the slippage we asked for.

Fees: without `ONECLICK_API_KEY` or `ONECLICK_JWT`, 1Click adds a 0.2% app fee (`appFees: [{fee: 20}]` on the quote). It is included in the card's "Fee $0.10" row (rounded up to the cent); the keyless detail stays in logs and here.

## Plain words for users

Everything a user sees is in everyday words (rule from Tobi, 6 Nov 2026). Card title "Buying $50 of SOL"; rows "You pay $50", "You'll get about 0.55 SOL, at least 0.545 SOL", "Fee $0.10", "Price 1 SOL ≈ $90", "Price good for 2 min", "Goes to your Penny wallet". The iPhone card shows the first three rows. Re-quote: "Price changed, check the new amount. Nothing moved." Errors: "Couldn't check the price. Try again.", "This expired. Ask Penny again." Never on screen: 1Click, intents, deposit address, delegate action, relayer, slippage, nonce, gas, base units, tx hashes, account ids, chain names. `apps/engine/test/invest.test.ts` fails if any of those reach a card, row or status.

Prices (`get_portfolios`, NEAR-send sizing in Guard): 1Click `/v0/tokens` first, CoinGecko simple price as fallback (public, no key), 60 s cache, 5 s timeout, stale (>15 min) prices refused, clear `PriceUnavailable` error.

## Relayer ceiling (fixed)

The relayer pays attached deposits in a meta-transaction, so it has a cap. It used to be a fixed 0.01 NEAR, so a NEAR send above 0.01 NEAR got a card and then failed at relay. Now:

- per approval, the relayer limit = the sum of the deposits the user approved;
- never above the env hard ceiling `PENNY_RELAYER_MAX_DEPOSIT_NEAR` (default 1 NEAR), checked before the card and again in the relayer;
- the amount itself was already bounded by Guard (per-tx, daily, mainnet launch caps), re-checked before relay.

Mainnet launch caps: `PENNY_MAINNET_MAX_PER_TX_USD` (default 25) and `PENNY_MAINNET_MAX_DAILY_USD` (default 50) are each clamped over the user's own policy, before the card and before relay.

## Do X, see Y

| Do | See |
|---|---|
| `bun test packages/chain/test/oneclick-recorded.test.ts` | real recorded 1Click quotes parse, live quote builds `storage_deposit` + `ft_transfer` to a 64-hex deposit address, 20 bps keyless fee |
| `bun test apps/engine/test/invest.test.ts` | preview rows, Guard block before quote/card, expired -> re-card (also after the expiry sweep, once), decline never re-quotes, price moved -> re-card, Sending / Buying now / Done / Refunded / Didn't go through card edits, no jargon on screen, daily cap, relayer ceiling |
| `bun test apps/engine/test/intents-invest.test.ts` | the real adapter path (quote -> cache -> buildActions) on recorded responses |
| `cd packages/chain && bun run scripts/invest-smoke.ts 1 SOL` | a real non-dry quote, the exact card actions, a throwaway-key signature that verifies, status `PENDING_DEPOSIT`. Broadcasts nothing |
| `bun run dev` with `NEAR_RPC_URL` set, text "put $5 in SOL" | preview, then a "Buying $5 of SOL" card with You pay / You'll get / Fee; approving in dry run settles as "Done" without touching chain |

## Live smoke (2026-11-06 13:31 UTC)

`scripts/invest-smoke.ts 1 SOL`, no API key, recipient and refund `penny.near`:

- amount in: 1.000000 USDC (`1000000`), $0.999536
- estimated out: 0.011083726 SOL (`11083726`), min received 0.010972888 SOL (1% slippage)
- rate: 1 SOL ≈ $90.22 (fees included); fee 20 bps (keyless)
- deposit address: `055f4b6155593082e72682f03695a38d334b8f3a5e4634d0d2bd96fb3088ac58`, a NEAR implicit account (64 hex); 1Click keeps it active ~3 days, Penny's card expires after 120 s
- delegate action: receiver USDC contract, actions `storage_deposit` + `ft_transfer`, 499 bytes, signed with a throwaway key, signature verified locally, **not relayed**
- status: `PENDING_DEPOSIT` (nothing was sent)

## What's live vs what needs a mainnet yes

Live now (no money moves): real prices, real dry and firm 1Click quotes, the exact deposit actions, Guard + caps + re-quote rules, signature verification, dry-run relay, status polling and card updates (tested on recorded responses).

Needs Tobi's explicit yes and these, for one tiny real invest:

1. A user NEAR account with the device key from the iPhone (full access) holding a few USDC (e.g. 1-2 USDC) on the native USDC contract.
2. A relayer account with ~0.1 NEAR (it fronts the 0.00125 NEAR storage deposit + gas per invest) and its key in `NEAR_RELAYER_ACCOUNT_ID` / `NEAR_RELAYER_PRIVATE_KEY`.
3. Env: `PENNY_ENV=mainnet`, `DRY_RUN=0`, `NEAR_NETWORK=mainnet`, `NEAR_RPC_URL` (mainnet), `PENNY_TESTNET_E2E_OK=1`, `APP_ATTEST_APP_ID`, plus the existing mainnet-required keys (DB, Spectrum, NEAR AI). Optional `ONECLICK_API_KEY` or `ONECLICK_JWT` to drop the 0.2% fee. Keep `PENNY_MAINNET_MAX_PER_TX_USD` and `PENNY_MAINNET_MAX_DAILY_USD` low for the first run.

Known limits: invest quotes live in process memory (an engine restart mid-card turns the next tap into "quote expired, ask for a fresh one"); the bought asset sits in the user's NEAR Intents balance, withdrawals to other chains are not built yet.
