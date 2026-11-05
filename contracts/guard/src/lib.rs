//! Penny Guard: give AI agents money without giving them the keys.
//!
//! One instance per user, deployed to `guard.<user>.penny.near` with **no access keys**
//! (a locked account), so nobody, Penny included, can redeploy or drain it.
//!
//! - The owner (the user account, whose only full-access key lives on their iPhone) funds a
//!   budget with `ft_transfer_call`, sets per-agent policies, pauses, revokes and withdraws.
//! - An agent spends by calling `spend` **from its own account**. The guard checks
//!   `predecessor_account_id` against that agent's policy (per-tx cap, UTC-day cap,
//!   recipient allowlist, allowed tokens, pause, revoke, expiry, nonce) and only then calls
//!   `ft_transfer` on the token. Agents never hold user funds or user keys.
//! - A failed `ft_transfer` (e.g. recipient not registered with the token) restores the
//!   budget and the day's spent counter in the callback.
//!
//! Errors are stable `E_*` codes so the engine can map a reverted spend to a Guard card.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub const EVENT_STANDARD: &str = "penny_guard";
pub const EVENT_VERSION: &str = "1.0.0";
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

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
    Budgets,
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
    owner_id: AccountId,
    tokens: Vec<AccountId>,
    paused_all: bool,
    agents: IterableMap<AccountId, AgentState>,
    budgets: LookupMap<AccountId, u128>,
}

pub fn utc_day(ts_ns: u64) -> u64 {
    ts_ns / NS_PER_DAY
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data]})
    ));
}

#[near]
impl Guard {
    /// Called in the same batch that creates and deploys the guard account, by the owner
    /// (predecessor == owner) or by the guard account itself.
    #[init]
    pub fn new(owner_id: AccountId, tokens: Vec<AccountId>) -> Self {
        let pred = env::predecessor_account_id();
        require!(
            pred == owner_id || pred == env::current_account_id(),
            "E_INIT_NOT_OWNER"
        );
        require!(owner_id != env::current_account_id(), "E_OWNER_IS_GUARD");
        require!(
            !tokens.is_empty() && tokens.len() <= MAX_TOKENS,
            "E_TOKENS_LEN"
        );
        let mut uniq = tokens.clone();
        uniq.sort();
        uniq.dedup();
        require!(uniq.len() == tokens.len(), "E_TOKENS_DUP");
        emit("init", json!({"owner_id": owner_id, "tokens": tokens}));
        Self {
            owner_id,
            tokens,
            paused_all: false,
            agents: IterableMap::new(StorageKey::Agents),
            budgets: LookupMap::new(StorageKey::Budgets),
        }
    }

    // ---------------------------------------------------------------- funding

    /// NEP-141 receiver. Only the owner funding an allowed token credits the budget;
    /// anything else is returned in full (the token contract refunds the sender).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg;
        let token = env::predecessor_account_id();
        if sender_id != self.owner_id || !self.tokens.contains(&token) || amount.0 == 0 {
            return PromiseOrValue::Value(amount);
        }
        let bal = self.budget_of(&token);
        let new_bal = bal
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("E_OVERFLOW"));
        self.budgets.insert(token.clone(), new_bal);
        emit(
            "deposit",
            json!({"token": token, "amount": amount, "budget": U128(new_bal)}),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ---------------------------------------------------------------- agents

    /// Agent-only. Reverts with an `E_*` code if any policy check fails, so a blocked spend
    /// changes nothing and moves nothing.
    pub fn spend(
        &mut self,
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
        require!(!self.paused_all, "E_PAUSED_ALL");
        let budget = self.budget_of(&token);
        let mut st = self
            .agents
            .get(&agent_id)
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
        require!(amount_u <= budget, "E_BUDGET");

        // effects before interaction
        st.last_nonce = nonce.0;
        Self::set_spent(&mut st, &token, day, new_spent);
        self.agents.insert(agent_id.clone(), st);
        self.budgets.insert(token.clone(), budget - amount_u);

        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(recipient.clone(), amount, memo.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_spend_complete(agent_id, token, recipient, amount, U64(day), nonce, memo),
            )
    }

    #[private]
    pub fn on_spend_complete(
        &mut self,
        #[callback_result] result: Result<(), PromiseError>,
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
                json!({"agent_id": agent_id, "token": token, "recipient": recipient,
                       "amount": amount, "nonce": nonce, "memo": memo}),
            );
            return true;
        }
        // roll back: budget always, day counter only if it is still that day's counter
        let bal = self.budget_of(&token);
        self.budgets
            .insert(token.clone(), bal.saturating_add(amount.0));
        if let Some(st) = self.agents.get_mut(&agent_id) {
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
            json!({"agent_id": agent_id, "token": token, "recipient": recipient,
                   "amount": amount, "nonce": nonce}),
        );
        false
    }

    // ---------------------------------------------------------------- owner

    /// Create or replace an agent's policy. Needs 1 yoctoNEAR (full-access signature).
    /// Keeps the agent's nonce and today's spend; clears paused and revoked.
    #[payable]
    pub fn set_policy(&mut self, agent_id: AccountId, policy: PolicyInput) {
        self.assert_owner_one_yocto();
        require!(
            agent_id != self.owner_id && agent_id != env::current_account_id(),
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
        let prev = self.agents.get(&agent_id).cloned();
        let st = AgentState {
            limits: policy.limits.clone(),
            allowlist: policy.allowlist.clone(),
            expires_at: policy.expires_at.map(|e| e.0),
            paused: false,
            revoked: false,
            last_nonce: prev.as_ref().map(|p| p.last_nonce).unwrap_or(0),
            spent: prev.map(|p| p.spent).unwrap_or_default(),
        };
        self.agents.insert(agent_id.clone(), st);
        emit(
            "policy_set",
            json!({"agent_id": agent_id, "limits": policy.limits,
                   "allowlist": policy.allowlist, "expires_at": policy.expires_at}),
        );
    }

    /// Safety-increasing: owner only, deposit optional.
    #[payable]
    pub fn pause_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        let st = self
            .agents
            .get_mut(&agent_id)
            .unwrap_or_else(|| env::panic_str("E_NO_POLICY"));
        st.paused = true;
        emit("paused", json!({"agent_id": agent_id}));
    }

    #[payable]
    pub fn resume_agent(&mut self, agent_id: AccountId) {
        self.assert_owner_one_yocto();
        let st = self
            .agents
            .get_mut(&agent_id)
            .unwrap_or_else(|| env::panic_str("E_NO_POLICY"));
        require!(!st.revoked, "E_REVOKED");
        st.paused = false;
        emit("resumed", json!({"agent_id": agent_id}));
    }

    #[payable]
    pub fn pause_all(&mut self) {
        self.assert_owner();
        self.paused_all = true;
        emit("paused", json!({"agent_id": null, "all": true}));
    }

    #[payable]
    pub fn resume_all(&mut self) {
        self.assert_owner_one_yocto();
        self.paused_all = false;
        emit("resumed", json!({"agent_id": null, "all": true}));
    }

    /// Safety-increasing: owner only, deposit optional. Re-enable with `set_policy`.
    #[payable]
    pub fn revoke_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        let st = self
            .agents
            .get_mut(&agent_id)
            .unwrap_or_else(|| env::panic_str("E_NO_POLICY"));
        st.revoked = true;
        st.limits.clear();
        st.allowlist.clear();
        emit("revoked", json!({"agent_id": agent_id}));
    }

    /// Owner only, 1 yoctoNEAR. Sends unspent budget back to the owner.
    #[payable]
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner_one_yocto();
        require!(env::prepaid_gas() >= GAS_MIN_PREPAID, "E_GAS");
        require!(amount.0 > 0, "E_ZERO");
        let bal = self.budget_of(&token);
        require!(amount.0 <= bal, "E_BUDGET");
        self.budgets.insert(token.clone(), bal - amount.0);
        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                self.owner_id.clone(),
                amount,
                Some("penny guard withdraw".into()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw_complete(token, amount),
            )
    }

    #[private]
    pub fn on_withdraw_complete(
        &mut self,
        #[callback_result] result: Result<(), PromiseError>,
        token: AccountId,
        amount: U128,
    ) -> bool {
        if result.is_ok() {
            emit("withdraw", json!({"token": token, "amount": amount}));
            return true;
        }
        let bal = self.budget_of(&token);
        self.budgets
            .insert(token.clone(), bal.saturating_add(amount.0));
        emit("withdraw_failed", json!({"token": token, "amount": amount}));
        false
    }

    /// Add a token (e.g. wrap.near) to the set agents can be given limits for.
    #[payable]
    pub fn add_token(&mut self, token: AccountId) {
        self.assert_owner_one_yocto();
        require!(!self.tokens.contains(&token), "E_TOKENS_DUP");
        require!(self.tokens.len() < MAX_TOKENS, "E_TOKENS_LEN");
        self.tokens.push(token.clone());
        emit("token_added", json!({"token": token}));
    }

    // ---------------------------------------------------------------- views

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_tokens(&self) -> Vec<AccountId> {
        self.tokens.clone()
    }

    pub fn is_paused_all(&self) -> bool {
        self.paused_all
    }

    pub fn get_budget(&self, token: AccountId) -> U128 {
        U128(self.budget_of(&token))
    }

    pub fn get_policy(&self, agent_id: AccountId) -> Option<PolicyView> {
        self.agents
            .get(&agent_id)
            .map(|st| Self::view(&agent_id, st))
    }

    pub fn get_agents(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<PolicyView> {
        self.agents
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(id, st)| Self::view(id, st))
            .collect()
    }

    /// Spent by this agent in this token during the current UTC day.
    pub fn get_spent_today(&self, agent_id: AccountId, token: AccountId) -> U128 {
        let day = utc_day(env::block_timestamp());
        U128(
            self.agents
                .get(&agent_id)
                .map(|st| Self::spent_on(st, &token, day))
                .unwrap_or(0),
        )
    }

    // ---------------------------------------------------------------- internal

    fn budget_of(&self, token: &AccountId) -> u128 {
        self.budgets.get(token).copied().unwrap_or(0)
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "E_NOT_OWNER"
        );
    }

    fn assert_owner_one_yocto(&self) {
        self.assert_owner();
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "E_ONE_YOCTO"
        );
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

    fn view(agent_id: &AccountId, st: &AgentState) -> PolicyView {
        PolicyView {
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
