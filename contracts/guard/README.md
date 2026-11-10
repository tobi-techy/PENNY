# Penny Guard contract

`res/penny_guard.wasm` is the **only** artifact deployed. It is one shared
contract instance (for example `guard.penny.testnet`), not one per user. Every
owner's budgets and agent policies live under keys prefixed with that owner's
account id. The contract account is deployed once, initialised with
`new(tokens)`, and then has **no access keys** (a locked account), so nobody,
Penny included, can redeploy or drain it. Tokens are fixed at init; there is no
`add_token`.

`res/test_usd.wasm` is the tUSD NEP-141 mock (`mock-ft`) used on testnet and in
sandbox tests. It is not part of the production Guard.

## Artifacts and checksums

| Artifact | sha256 |
|---|---|
| `res/penny_guard.wasm` | `90fe7051ce2ec03b9c6e7bd41a88b430ca496818eaa08a647d271cdedb968984` |
| `res/test_usd.wasm` | `2b8baf9d53496cb63d7410915132fc07d12b6338db8fb998a271cf3a75fe5d57` |

Built from this workspace with Rust 1.99.1 for `wasm32-unknown-unknown`
(`rust-toolchain.toml` pins both). Rebuild and print the hashes with:

```bash
./build.sh
```

CI runs `cargo test --workspace`, the same wasm build, and prints both hashes
(`.github/workflows/ci.yml`, job `contract`). Compare its output with the table
above before deploying.

## Contract API (v2, shared multi-tenant)

Init (caller must be the contract itself or its parent): `new(tokens: Vec<AccountId>)`.

Agent-signed: `spend(owner_id, token, recipient, amount: U128, memo, nonce: U64)`.
The agent calls from its own account and the contract enforces the owner's policy.

Owner-signed (predecessor is the owner; these carry 1 yocto where the contract
requires it): `set_policy(agent_id, policy)`, `pause_agent(agent_id)`,
`resume_agent(agent_id)`, `revoke_agent(agent_id)`, `pause_all()`, `resume_all()`,
`withdraw(token, amount: U128)`.

Views: `get_tokens()`, `is_paused_all(owner_id)`, `get_budget(owner_id, token)`,
`get_policy(owner_id, agent_id)`, `get_agents(owner_id)`,
`get_spent_today(owner_id, agent_id, token)`.

Owners fund their own budget with `ft_transfer_call` (optionally setting policies
in `msg`). A failed `ft_transfer` restores the owner's budget and the agent's day
counter.
