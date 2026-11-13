# Concordium registration proof

Network: testnet (`ccd:4221332d34e1694168c2a0c0b3fd0f27`)
Owner account: `3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT`
Contracts: CIS-8004 `<12802,0>`, CIS-8 `<12801,0>`
Checked: 2026-11-13T14:14:06.374Z

## Badges

| Agent | Token | Badge | Verified | Card hash | Owner | Verification block | Register | Pin |
|---|---|---|---|---|---|---|---|---|
| Penny | 1169 | `JyP9Wd81dn3JwiAs6agks` | yes | yes | yes | yes | [register](https://ccdexplorer.io/testnet/transaction/6336cd403b406d1f2026d75bb619a5f167cbd1345318d4c64dc3d879c222b38b) | [pin](https://ccdexplorer.io/testnet/transaction/29997c451d723297c4e4d0ebabbdb83f771ef46aa94d5c6c782870625f4935d9) |
| Guard | 1170 | `JyP9WeDVZoYEmqQfdWWtd` | yes | yes | yes | yes | [register](https://ccdexplorer.io/testnet/transaction/c48114d5e1cc4b378ecd7eb38b4c8de997c8f16ccfa3d9aa69054b0080c6d634) | [pin](https://ccdexplorer.io/testnet/transaction/111f4010276b420e86fce5f86339cc0f22701b6a6bebfc5f07362b120b3f8341) |
| Invest | 1171 | `JyP9WfJyVq3AbxeVcM9Sp` | yes | yes | yes | yes | [register](https://ccdexplorer.io/testnet/transaction/4c8578f65e304502c79d08567d4706f008378520205212acccf5da8c1573f6f7) | [pin](https://ccdexplorer.io/testnet/transaction/ac550757aeb48d91e2312cbdfd931ba202066e92716f2c56b52bc4c3456ca003) |
| Mail | 1172 | `JyP9WgQTRrY6S5tFdiQi3` | yes | yes | yes | yes | [register](https://ccdexplorer.io/testnet/transaction/b9b681a54ace7250183ebe752bab15be6114a381ae785f9b5e418c22481426eb) | [pin](https://ccdexplorer.io/testnet/transaction/956931d2a7c2fed71a33ad1f068e6fd5bf4d4c0362e422f72a31eaaaa6fba400) |

## Card hashes

| Agent | Card URL | SHA-256 | Served bytes match |
|---|---|---|---|
| Penny | https://nonunified-melda-inflexionally.ngrok-free.dev/agent-card.json | `6f10957ecc9ab4dbbe8e0e85e49a76a0f55fd55ec794210fc9f0593c4633cb67` | yes |
| Guard | https://nonunified-melda-inflexionally.ngrok-free.dev/agents/guard/agent-card.json | `073146dee5986e4e443e18c6e37571fb6a6479e44bd64ee7ac5e5bc0b707bdb5` | yes |
| Invest | https://nonunified-melda-inflexionally.ngrok-free.dev/agents/invest/agent-card.json | `e5ee628c0c87ed65b37e25217d456dd6ce05614399f090d9bac6d8f66a7113eb` | yes |
| Mail | https://nonunified-melda-inflexionally.ngrok-free.dev/agents/mail/agent-card.json | `c817c8f3f8b4ba1d9c7679c82ae1770aa69581d3051ed2a8312906ddb2767bf9` | yes |

## Verify it yourself

```bash
# Replace <badge> with any badge above.
curl -s "https://agent-registry-mcp.concordium.com/v1/check-badge/<badge>?network=testnet" | jq .
```

Every check above is computed from the registry MCP response and the served card bytes. The script does not trust the cards or the owner's local state.

## Hosting caveat

During this spike the cards are served from a temporary ngrok tunnel. The on-chain pins are correct, but the URLs stop resolving when the tunnel closes. Before submission, rebuild the cards against the stable base URL and re-pin each hash:

```bash
CONCORDIUM_CARD_BASE_URL=https://raw.githubusercontent.com/tobi-techy/PENNY/main \
  node scripts/concordium/build-cards.mjs penny guard invest mail
node scripts/concordium/register.mjs pin penny https://raw.githubusercontent.com/tobi-techy/PENNY/main/agents/penny/agent-card.json
# repeat pin for guard, invest, and mail
```

