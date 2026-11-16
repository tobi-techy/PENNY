# Adding money

Penny can bring dollars in from another chain. The user says "add $20", names where it is coming from, and Penny gives an address that only receives. The deposit is delivered as USDC to the user's own NEAR account through NEAR Intents 1Click.

Nothing here needs Face ID. The address is not a key, the money never passes through Penny, and the only thing Penny does with it is follow the deposit and say when it lands.

## Flow

```
"add $20 from base"
  -> add_money          amount and chain checked in code. No card yet.
  -> 1Click quote       dry=false: USDC on Base -> USDC on NEAR,
                        recipient = user's NEAR account, recipientType DESTINATION_CHAIN,
                        refundType INTENTS, refundTo = the same NEAR account.
  -> card + text        an "Add money" card (blue, no Face ID) and a text with the
                        address, because a card cannot be copied from.
  -> funding_quotes     one row per top-up: address, amount, chain, expiry, state.
  -> poll (60 s)        PENDING_DEPOSIT / KNOWN_DEPOSIT_TX stay quiet.
                        PROCESSING edits the card in place ("the dollars are on their way…").
                        SUCCESS edits it to "Added" and texts once.
                        REFUNDED says the money came back, once.
                        FAILED says nothing was taken, once.
                        EXPIRY marks the card expired and sends nothing.
```

## Why it is safe

- **The address only receives.** It is a 1Click deposit address, not a Penny account and not a user key. Holding it gives no spending power.
- **Refunds go to the user.** `refundType: INTENTS` with `refundTo` = the user's own NEAR account means an unfilled deposit returns to their Intents balance, never to a Penny wallet.
- **Chains are gated by 1Click's own token list.** `IntentsFunding.chains()` offers a chain only when its USDC asset id is in the live `/v0/tokens` response. A chain whose asset id changed quietly disappears instead of sending someone to a dead address.
- **Exact amounts only.** The quote is `EXACT_INPUT`; both the card and the text say "send exactly". A short or wrong deposit is refunded by 1Click, not credited.
- **One message per outcome.** `FundingRepo.claim` moves a row out of a live state exactly once, so two polls or two engine instances cannot text the same landing twice.
- **No approval, no spend path.** `add_money` is `risk: read` and `add_money: false` in `cards/policy.ts`. It cannot move money, and it creates no `Approval` row.

## What is live vs not

Live now: the quote, the card, the copyable text, the stored row, the poll and every terminal message, tested against recorded 1Click responses and a scripted market.

Not live here: 1Click has no testnet, so on a testnet engine the rail is off and Penny says so (`isn't switched on here yet`) instead of inventing an address. Mainnet needs nothing beyond the existing 1Click credentials already used by Invest.

Known limits:
- the deposit must match the quoted amount; there is no top-up-to-a-running-deposit flow;
- one address per top-up, expired silently after its 1Click deadline;
- no fee display on the card: the 1Click fee is inside the guaranteed minimum, and a 0.2% keyless fee applies when no partner key is set;
- the wallet balance updates through `get_balances`; the card itself is not a balance screen.

## Do X, see Y

| Do | See |
|---|---|
| `bun test apps/engine/test/funding.test.ts` | card, text, row, refund, failure, expiry, minimum, unsupported chain, and the honest "not switched on" answer |
| `bun run dev`, text "add $20 from base" | the rail-off copy on a dev/testnet engine |
| on a mainnet engine with 1Click keys, text "add $20 from base" | an Add money card and an address; send $20 USDC on Base from any wallet; the card flips to Added and Penny texts once |
