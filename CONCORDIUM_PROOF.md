# Concordium registration proof

Network: testnet (`ccd:4221332d34e1694168c2a0c0b3fd0f27`)
Owner account: `3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT`
Contracts: CIS-8004 `<12802,0>`, CIS-8 `<12801,0>`
Checked: 2026-11-16T10:25:14.074Z

## Badges

| Agent | Token | Badge | Verified | Card hash | Owner | Verification block | Register | Pin |
|---|---|---|---|---|---|---|---|---|
| Penny | 1169 | `JyP9Wd81dn3JwiAs6agks` | yes | yes | yes | yes | [register](https://ccdexplorer.io/testnet/transaction/6336cd403b406d1f2026d75bb619a5f167cbd1345318d4c64dc3d879c222b38b) | [pin](https://ccdexplorer.io/testnet/transaction/3d52e2e26098cef61dd818892bf182cfb842a4a3b6e7f8c3668b5fbf7f6a06e4) |
| Guard | 1170 | `JyP9WeDVZoYEmqQfdWWtd` | yes | yes | yes | yes | [register](https://ccdexplorer.io/testnet/transaction/c48114d5e1cc4b378ecd7eb38b4c8de997c8f16ccfa3d9aa69054b0080c6d634) | [pin](https://ccdexplorer.io/testnet/transaction/6d91db5cad09a03de2a2da90506dcf9f797597d5105ec7694eab9799ca4a45af) |
| Invest | 1171 | `JyP9WfJyVq3AbxeVcM9Sp` | yes | yes | yes | yes | [register](https://ccdexplorer.io/testnet/transaction/4c8578f65e304502c79d08567d4706f008378520205212acccf5da8c1573f6f7) | [pin](https://ccdexplorer.io/testnet/transaction/276456886bc419defe58d7ec7ba899d35d3c3b4b3be394ac61989a0e6b889db2) |
| Mail | 1172 | `JyP9WgQTRrY6S5tFdiQi3` | yes | yes | yes | yes | [register](https://ccdexplorer.io/testnet/transaction/b9b681a54ace7250183ebe752bab15be6114a381ae785f9b5e418c22481426eb) | [pin](https://ccdexplorer.io/testnet/transaction/956931d2a7c2fed71a33ad1f068e6fd5bf4d4c0362e422f72a31eaaaa6fba400) |

## Card hashes

| Agent | Card URL | SHA-256 | Served bytes match |
|---|---|---|---|
| Penny | https://penny-passport.vercel.app/agents/penny/agent-card.json | `3484d6ce155fac839e27dceaf9ff6e98f6df71ec6af5b1f1c2131dc245f25e44` | yes |
| Guard | https://penny-passport.vercel.app/agents/guard/agent-card.json | `8414adfb9dc5c6e71e55f284a9690ac09e60e87160ee76522221cf32c2e41ffb` | yes |
| Invest | https://penny-passport.vercel.app/agents/invest/agent-card.json | `526367d2c3d51e52cdf6540acd8cc640780c3bd97fc4607aceb8e1cef1ea3497` | yes |
| Mail | https://penny-passport.vercel.app/agents/mail/agent-card.json | `2832e329e65a1dbb584fd7792205cd70968e7d49f41d1218b6987430bc2f1dbe` | yes |

## Verify it yourself

```bash
# Replace <badge> with any badge above.
curl -s "https://agent-registry-mcp.concordium.com/v1/check-badge/<badge>?network=testnet" | jq .
```

Every check above is computed from the registry MCP response and the served card bytes. The script does not trust the cards or the owner's local state.

## Hosting

Cards and passport pages are served from the permanent static host
`https://penny-passport.vercel.app` (source: `apps/engine/public-static`,
regenerated with `bun run concordium:export`). The card URL is part of the
hashed, on-chain-pinned bytes, so a host change requires rebuilding the cards
with the new `CONCORDIUM_CARD_BASE_URL`, re-pin, and redeploy:

```bash
CONCORDIUM_CARD_BASE_URL=https://penny-passport.vercel.app \
  node scripts/concordium/build-cards.mjs penny guard invest mail
bun run concordium:export
cd apps/engine/public-static && vercel --yes --prod
node scripts/concordium/register.mjs pin penny https://penny-passport.vercel.app/agents/penny/agent-card.json
# repeat pin for guard, invest, and mail
```

