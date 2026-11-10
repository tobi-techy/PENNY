//! Penny Guard: give AI agents money without giving them the keys.
//!
//! One shared ("multi-tenant") deployment, e.g. `guard.penny.near`, with **no access keys**
//! (a locked account), so nobody, Penny included, can redeploy or drain it. Every owner's
//! budgets and agent policies live under keys prefixed with that owner's account id, so
//! owners are isolated from each other and nothing is ever iterated globally.
//!
//! - An owner (a user account, whose only full-access key lives on their iPhone) funds their
//!   own budget with `ft_transfer_call` (optionally setting agent policies in the same call
//!   via `msg`), sets per-agent policies, pauses, revokes and withdraws. Owner methods always
//!   act on `predecessor_account_id`'s own state.
//! - An agent spends by calling `spend(owner_id, ...)` **from its own account**. The guard
//!   checks `predecessor_account_id` against the policy that owner set for that agent
//!   (per-tx cap, UTC-day cap, recipient allowlist, allowed tokens, pause, revoke, expiry,
//!   nonce) and only then calls `ft_transfer` on the token, debiting that owner's budget.
//!   Agents never hold user funds or user keys.
//! - A failed `ft_transfer` (e.g. recipient not registered with the token) restores that
//!   owner's budget and the agent's day counter in the callback.
//!
//! Errors are stable `E_*` codes so the engine can map a reverted spend to a Guard card.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub const EVENT_STANDARD: &str = "penny_guard";
pub const EVENT_VERSION: &str = "2.0.0";
pub const NS_PER_DAY: u64 = 86_400_000_000_000;
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub const GAS_CALLBACK: Gas = Gas::from_tgas(15);
/// spend/withdraw must carry enough gas for the transfer, the callback and their own work,
/// otherwise a failed transfer could not be rolled back.
pub const GAS_MIN_PREPAID: Gas = Gas::from_tgas(45);
pub const MAX_TOKENS: usize = 8;
pub const MAX_LIMITS: usize = 8;
pub const MAX_ALLOWLIST: usize = 64;
pub const MAX_MEMO_LEN: usize = 128;
/// Agents (including revoked ones, which keep their nonce) one owner can have.
pub const MAX_AGENTS: usize = 16;
/// Policies one `ft_transfer_call` msg can set.
pub const MAX_MSG_POLICIES: usize = 8;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    /// "owner:token" -> u128
    Budgets,
    /// "owner:agent" -> AgentState
    Policies,
    /// owner -> agent ids
    AgentLists,
    /// owner -> true (absent = not paused)
    PausedAll,
}

/// Caps for one token, in that token's base units (USDC: 6 decimals, wNEAR: 24).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenLimit {
    pub token: AccountId,
    pub per_tx_cap: U128,
    pub daily_cap: U128,
}

/// What the owner sets for an agent. A token without a limit entry is not allowed.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PolicyInput {
    pub limits: Vec<TokenLimit>,
    /// Empty = any recipient. Non-empty = only these recipients.
    #[serde(default)]
    pub allowlist: Vec<AccountId>,
    /// Unix time in nanoseconds (same clock as `block_timestamp`). None = no expiry.
    #[serde(default)]
    pub expires_at: Option<U64>,
}

/// One entry of the `ft_transfer_call` msg.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AgentPolicyInput {
    pub agent_id: AccountId,
    pub policy: PolicyInput,
}

/// `ft_transfer_call` msg: `{"policies":[{"agent_id":"...","policy":{...}}]}`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FundMsg {
    pub policies: Vec<AgentPolicyInput>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct SpentEntry {
    pub token: AccountId,
    pub day: u64,
    pub amount: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct AgentState {
    pub limits: Vec<TokenLimit>,
    pub allowlist: Vec<AccountId>,
    pub expires_at: Option<u64>,
    pub paused: bool,
    pub revoked: bool,
    /// Highest nonce used. Kept across revoke/re-add so old nonces never replay.
    pub last_nonce: u64,
    pub spent: Vec<SpentEntry>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PolicyView {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub limits: Vec<TokenLimit>,
    pub allowlist: Vec<AccountId>,
    pub expires_at: Option<U64>,
    pub paused: bool,
    pub revoked: bool,
    pub last_nonce: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    tokens: Vec<AccountId>,
    budgets: LookupMap<String, u128>,
    policies: LookupMap<String, AgentState>,
    agent_lists: LookupMap<AccountId, Vec<AccountId>>,
    paused_all: LookupMap<AccountId, bool>,
}

pub fn utc_day(ts_ns: u64) -> u64 {
    ts_ns / NS_PER_DAY
}

/// Composite key. Account ids cannot contain ':', so "a:b" is unambiguous.
fn key(owner: &AccountId, other: &AccountId) -> String {
    format!("{owner}:{other}")
}

/// `guard.penny.testnet` -> `penny.testnet`; top-level accounts have no parent.
fn parent_of(account: &AccountId) -> Option<&str> {
    account.as_str().split_once('.').map(|(_, p)| p)
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data]})
    ));
}

fn assert_one_yocto() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(1),
        "E_ONE_YOCTO"
    );
}

#[near]
impl Guard {
    /// Called in the same batch that creates and deploys the guard account, by the parent
    /// account (the deployer) or by the guard account itself. Tokens are fixed for life.
    #[init]
    pub fn new(tokens: Vec<AccountId>) -> Self {
        let pred = env::predecessor_account_id();
        let me = env::current_account_id();
        require!(
            pred == me || parent_of(&me) == Some(pred.as_str()),
            "E_INIT_NOT_ALLOWED"
        );
        require!(
            !tokens.is_empty() && tokens.len() <= MAX_TOKENS,
            "E_TOKENS_LEN"
        );
        let mut uniq = tokens.clone();
        uniq.sort();
        uniq.dedup();
        require!(uniq.len() == tokens.len(), "E_TOKENS_DUP");
        emit("init", json!({"tokens": tokens}));
        Self {
            tokens,
            budgets: LookupMap::new(StorageKey::Budgets),
            policies: LookupMap::new(StorageKey::Policies),
            agent_lists: LookupMap::new(StorageKey::AgentLists),
            paused_all: LookupMap::new(StorageKey::PausedAll),
        }
    }

    // ---------------------------------------------------------------- funding

    /// NEP-141 receiver. Credits `sender_id`'s budget for an allowed token; anything else is
    /// returned in full. A non-empty `msg` sets agent policies for `sender_id`; an invalid
    /// msg panics so the token refunds the whole transfer.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        if !self.tokens.contains(&token) || amount.0 == 0 {
            return PromiseOrValue::Value(amount);
        }
        let owner_id = sender_id;
        let k = key(&owner_id, &token);
        let bal = self.budgets.get(&k).copied().unwrap_or(0);
        let new_bal = bal
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("E_OVERFLOW"));
        self.budgets.insert(k, new_bal);
        emit(
            "deposit",
            json!({"owner_id": owner_id, "token": token, "amount": amount,
                   "budget": U128(new_bal)}),
        );
        if !msg.is_empty() {
            let parsed: FundMsg =
                serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("E_MSG"));
            require!(parsed.policies.len() <= MAX_MSG_POLICIES, "E_MSG_LEN");
            for p in parsed.policies {
                self.internal_set_policy(&owner_id, p.agent_id, p.policy);
            }
        }
        PromiseOrValue::Value(U128(0))
    }

    // ---------------------------------------------------------------- agents

    /// Agent-only. Reverts with an `E_*` code if any policy check fails, so a blocked spend
    /// changes nothing and moves nothing.
    pub fn spend(
        &mut self,
        owner_id: AccountId,
        token: AccountId,
        recipient: AccountId,
        amount: U128,
        memo: Option<String>,
        nonce: U64,
    ) -> Promise {
        require!(env::prepaid_gas() >= GAS_MIN_PREPAID, "E_GAS");
        let agent_id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let day = utc_day(now);
        let amount_u = amount.0;
        if let Some(m) = &memo {
            require!(m.len() <= MAX_MEMO_LEN, "E_MEMO_LEN");
        }
        require!(!self.is_paused_all(owner_id.clone()), "E_PAUSED_ALL");
        let pkey = key(&owner_id, &agent_id);
        let mut st = self
            .policies
            .get(&pkey)
            .cloned()
            .unwrap_or_else(|| env::panic_str("E_NO_POLICY"));
        require!(!st.revoked, "E_REVOKED");
        require!(!st.paused, "E_PAUSED");
        if let Some(exp) = st.expires_at {
            require!(now < exp, "E_EXPIRED");
        }
        require!(nonce.0 > st.last_nonce, "E_NONCE");
        require!(amount_u > 0, "E_ZERO");
        require!(self.tokens.contains(&token), "E_TOKEN");
        let limit = st
            .limits
            .iter()
            .find(|l| l.token == token)
            .cloned()
            .unwrap_or_else(|| env::panic_str("E_TOKEN_NOT_ALLOWED"));
        require!(
            recipient != env::current_account_id() && recipient != agent_id,
            "E_RECIPIENT"
        );
        require!(
            st.allowlist.is_empty() || st.allowlist.contains(&recipient),
            "E_NOT_ALLOWLISTED"
        );
        require!(amount_u <= limit.per_tx_cap.0, "E_OVER_TX_CAP");
        let spent_today = Self::spent_on(&st, &token, day);
        let new_spent = spent_today
            .checked_add(amount_u)
            .unwrap_or_else(|| env::panic_str("E_OVERFLOW"));
        require!(new_spent <= limit.daily_cap.0, "E_OVER_DAILY_CAP");
        let bkey = key(&owner_id, &token);
        let budget = self.budgets.get(&bkey).copied().unwrap_or(0);
        require!(amount_u <= budget, "E_BUDGET");

        // effects before interaction
        st.last_nonce = nonce.0;
        Self::set_spent(&mut st, &token, day, new_spent);
        self.policies.insert(pkey, st);
        self.budgets.insert(bkey, budget - amount_u);

        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(recipient.clone(), amount, memo.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_spend_complete(
                        owner_id,
                        agent_id,
                        token,
                        recipient,
                        amount,
                        U64(day),
                        nonce,
                        memo,
                    ),
            )
    }

    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_spend_complete(
        &mut self,
        #[callback_result] result: Result<(), PromiseError>,
        owner_id: AccountId,
        agent_id: AccountId,
        token: AccountId,
        recipient: AccountId,
        amount: U128,
        day: U64,
        nonce: U64,
        memo: Option<String>,
    ) -> bool {
        if result.is_ok() {
            emit(
                "spend",
                json!({"owner_id": owner_id, "agent_id": agent_id, "token": token,
                       "recipient": recipient, "amount": amount, "nonce": nonce, "memo": memo}),
            );
            return true;
        }
        // roll back: budget always, day counter only if it is still that day's counter
        self.credit(&owner_id, &token, amount.0);
        if let Some(st) = self.policies.get_mut(&key(&owner_id, &agent_id)) {
            if let Some(e) = st
                .spent
                .iter_mut()
                .find(|e| e.token == token && e.day == day.0)
            {
                e.amount = e.amount.saturating_sub(amount.0);
            }
        }
        emit(
            "spend_failed",
            json!({"owner_id": owner_id, "agent_id": agent_id, "token": token,
                   "recipient": recipient, "amount": amount, "nonce": nonce}),
        );
        false
    }

    // ---------------------------------------------------------------- owner (= predecessor)

    /// Create or replace one of the caller's agent policies. Needs exactly 1 yoctoNEAR
    /// (full-access signature) and a non-zero budget in at least one token named in
    /// `policy.limits` (`E_NO_BUDGET`). Keeps the agent's nonce and today's spend; clears
    /// paused and revoked.
    #[payable]
    pub fn set_policy(&mut self, agent_id: AccountId, policy: PolicyInput) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        self.internal_set_policy(&owner_id, agent_id, policy);
    }

    /// Safety-increasing: deposit optional.
    #[payable]
    pub fn pause_agent(&mut self, agent_id: AccountId) {
        let owner_id = env::predecessor_account_id();
        let st = self.policy_mut(&owner_id, &agent_id);
        st.paused = true;
        emit("paused", json!({"owner_id": owner_id, "agent_id": agent_id}));
    }

    #[payable]
    pub fn resume_agent(&mut self, agent_id: AccountId) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        let st = self.policy_mut(&owner_id, &agent_id);
        require!(!st.revoked, "E_REVOKED");
        st.paused = false;
        emit("resumed", json!({"owner_id": owner_id, "agent_id": agent_id}));
    }

    /// Safety-increasing: deposit optional. Stops every agent of the caller.
    #[payable]
    pub fn pause_all(&mut self) {
        let owner_id = env::predecessor_account_id();
        self.paused_all.insert(owner_id.clone(), true);
        emit(
            "paused",
            json!({"owner_id": owner_id, "agent_id": null, "all": true}),
        );
    }

    #[payable]
    pub fn resume_all(&mut self) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        self.paused_all.remove(&owner_id);
        emit(
            "resumed",
            json!({"owner_id": owner_id, "agent_id": null, "all": true}),
        );
    }

    /// Safety-increasing: deposit optional. Re-enable with `set_policy`.
    #[payable]
    pub fn revoke_agent(&mut self, agent_id: AccountId) {
        let owner_id = env::predecessor_account_id();
        let st = self.policy_mut(&owner_id, &agent_id);
        st.revoked = true;
        st.limits.clear();
        st.allowlist.clear();
        emit("revoked", json!({"owner_id": owner_id, "agent_id": agent_id}));
    }

    /// 1 yoctoNEAR. Sends unspent budget from the caller's own budget back to the caller.
    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        require!(env::prepaid_gas() >= GAS_MIN_PREPAID, "E_GAS");
        require!(amount.0 > 0, "E_ZERO");
        let owner_id = env::predecessor_account_id();
        let k = key(&owner_id, &token);
        let bal = self.budgets.get(&k).copied().unwrap_or(0);
        require!(amount.0 <= bal, "E_BUDGET");
        self.budgets.insert(k, bal - amount.0);
        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                owner_id.clone(),
                amount,
                Some("penny guard withdraw".into()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw_complete(owner_id, token, amount),
            )
    }

    #[private]
    pub fn on_withdraw_complete(
        &mut self,
        #[callback_result] result: Result<(), PromiseError>,
        owner_id: AccountId,
        token: AccountId,
        amount: U128,
    ) -> bool {
        if result.is_ok() {
            emit(
                "withdraw",
                json!({"owner_id": owner_id, "token": token, "amount": amount}),
            );
            return true;
        }
        self.credit(&owner_id, &token, amount.0);
        emit(
            "withdraw_failed",
            json!({"owner_id": owner_id, "token": token, "amount": amount}),
        );
        false
    }

    // ---------------------------------------------------------------- views

    pub fn get_tokens(&self) -> Vec<AccountId> {
        self.tokens.clone()
    }

    pub fn is_paused_all(&self, owner_id: AccountId) -> bool {
        self.paused_all.get(&owner_id).copied().unwrap_or(false)
    }

    pub fn get_budget(&self, owner_id: AccountId, token: AccountId) -> U128 {
        U128(self.budgets.get(&key(&owner_id, &token)).copied().unwrap_or(0))
    }

    pub fn get_policy(&self, owner_id: AccountId, agent_id: AccountId) -> Option<PolicyView> {
        self.policies
            .get(&key(&owner_id, &agent_id))
            .map(|st| Self::view(&owner_id, &agent_id, st))
    }

    /// All of an owner's agents (at most `MAX_AGENTS`), revoked ones included.
    pub fn get_agents(&self, owner_id: AccountId) -> Vec<PolicyView> {
        self.agent_lists
            .get(&owner_id)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.get_policy(owner_id.clone(), id.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Spent by this owner's agent in this token during the current UTC day.
    pub fn get_spent_today(&self, owner_id: AccountId, agent_id: AccountId, token: AccountId) -> U128 {
        let day = utc_day(env::block_timestamp());
        U128(
            self.policies
                .get(&key(&owner_id, &agent_id))
                .map(|st| Self::spent_on(st, &token, day))
                .unwrap_or(0),
        )
    }

    // ---------------------------------------------------------------- internal

    fn internal_set_policy(&mut self, owner_id: &AccountId, agent_id: AccountId, policy: PolicyInput) {
        require!(
            &agent_id != owner_id && agent_id != env::current_account_id(),
            "E_AGENT_ID"
        );
        require!(
            !policy.limits.is_empty() && policy.limits.len() <= MAX_LIMITS,
            "E_LIMITS_LEN"
        );
        require!(policy.allowlist.len() <= MAX_ALLOWLIST, "E_ALLOWLIST_LEN");
        let mut seen: Vec<&AccountId> = Vec::new();
        for l in &policy.limits {
            require!(self.tokens.contains(&l.token), "E_TOKEN");
            require!(!seen.contains(&&l.token), "E_LIMITS_DUP");
            seen.push(&l.token);
            require!(l.per_tx_cap.0 > 0, "E_CAP_ZERO");
            require!(l.per_tx_cap.0 <= l.daily_cap.0, "E_CAP_ORDER");
        }
        if let Some(exp) = policy.expires_at {
            require!(exp.0 > env::block_timestamp(), "E_EXPIRES_PAST");
        }
        // Anti storage-griefing: the shared contract pays for policy storage, so only owners
        // who already funded one of the policy's tokens can create or replace policies.
        // (Safety-increasing calls such as pause/revoke never need a budget.)
        require!(
            policy.limits.iter().any(|l| self
                .budgets
                .get(&key(owner_id, &l.token))
                .is_some_and(|b| *b > 0)),
            "E_NO_BUDGET"
        );
        let pkey = key(owner_id, &agent_id);
        let prev = self.policies.get(&pkey).cloned();
        if prev.is_none() {
            let mut ids = self.agent_lists.get(owner_id).cloned().unwrap_or_default();
            require!(ids.len() < MAX_AGENTS, "E_AGENTS_LEN");
            ids.push(agent_id.clone());
            self.agent_lists.insert(owner_id.clone(), ids);
        }
        let st = AgentState {
            limits: policy.limits.clone(),
            allowlist: policy.allowlist.clone(),
            expires_at: policy.expires_at.map(|e| e.0),
            paused: false,
            revoked: false,
            last_nonce: prev.as_ref().map(|p| p.last_nonce).unwrap_or(0),
            spent: prev.map(|p| p.spent).unwrap_or_default(),
        };
        self.policies.insert(pkey, st);
        emit(
            "policy_set",
            json!({"owner_id": owner_id, "agent_id": agent_id, "limits": policy.limits,
                   "allowlist": policy.allowlist, "expires_at": policy.expires_at}),
        );
    }

    fn policy_mut(&mut self, owner_id: &AccountId, agent_id: &AccountId) -> &mut AgentState {
        self.policies
            .get_mut(&key(owner_id, agent_id))
            .unwrap_or_else(|| env::panic_str("E_NO_POLICY"))
    }

    fn credit(&mut self, owner_id: &AccountId, token: &AccountId, amount: u128) {
        let k = key(owner_id, token);
        let bal = self.budgets.get(&k).copied().unwrap_or(0);
        self.budgets.insert(k, bal.saturating_add(amount));
    }

    fn spent_on(st: &AgentState, token: &AccountId, day: u64) -> u128 {
        st.spent
            .iter()
            .find(|e| &e.token == token && e.day == day)
            .map(|e| e.amount)
            .unwrap_or(0)
    }

    /// One entry per token: an old day's entry is overwritten, so state never grows.
    fn set_spent(st: &mut AgentState, token: &AccountId, day: u64, amount: u128) {
        if let Some(e) = st.spent.iter_mut().find(|e| &e.token == token) {
            e.day = day;
            e.amount = amount;
        } else {
            st.spent.push(SpentEntry {
                token: token.clone(),
                day,
                amount,
            });
        }
    }

    fn view(owner_id: &AccountId, agent_id: &AccountId, st: &AgentState) -> PolicyView {
        PolicyView {
            owner_id: owner_id.clone(),
            agent_id: agent_id.clone(),
            limits: st.limits.clone(),
            allowlist: st.allowlist.clone(),
            expires_at: st.expires_at.map(U64),
            paused: st.paused,
            revoked: st.revoked,
            last_nonce: U64(st.last_nonce),
        }
    }
}

#[cfg(test)]
mod tests;
