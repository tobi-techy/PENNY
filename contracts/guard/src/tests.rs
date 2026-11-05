use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const DAY: u64 = NS_PER_DAY;
const T0: u64 = 1_800_000_000_000_000_000; // some time in 2027

fn a(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    a("tobi.penny.near")
}
fn guard_id() -> AccountId {
    a("guard.tobi.penny.near")
}
fn usdc() -> AccountId {
    a("usdc.near")
}
fn wnear() -> AccountId {
    a("wrap.near")
}
fn agent() -> AccountId {
    a("invest.penny.near")
}
fn bob() -> AccountId {
    a("bob.near")
}

fn ctx(pred: AccountId, ts: u64, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(guard_id())
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred)
        .block_timestamp(ts)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(100));
    b
}

fn set(pred: AccountId, ts: u64, deposit: u128) {
    testing_env!(ctx(pred, ts, deposit).build());
}

fn set_with_result(ts: u64, r: PromiseResult) {
    testing_env!(
        ctx(guard_id(), ts, 0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![r]
    );
}

fn limits(per_tx: u128, daily: u128) -> Vec<TokenLimit> {
    vec![TokenLimit {
        token: usdc(),
        per_tx_cap: U128(per_tx),
        daily_cap: U128(daily),
    }]
}

/// Guard with 100 USDC budget and agent policy 10/tx, 25/day, no allowlist.
fn setup() -> Guard {
    set(owner(), T0, 0);
    // mocked storage survives testing_env!; start every guard from an empty trie
    let _ = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
    let mut g = Guard::new(owner(), vec![usdc(), wnear()]);
    set(usdc(), T0, 0);
    let r = g.ft_on_transfer(owner(), U128(100), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    set(owner(), T0, 1);
    g.set_policy(
        agent(),
        PolicyInput {
            limits: limits(10, 25),
            allowlist: vec![],
            expires_at: None,
        },
    );
    g
}

fn spend(g: &mut Guard, amount: u128, nonce: u64) {
    set(agent(), T0, 0);
    let _ = g.spend(usdc(), bob(), U128(amount), None, U64(nonce));
}

fn panics<F: FnOnce() + std::panic::UnwindSafe>(f: F, code: &str) {
    let err = std::panic::catch_unwind(f).expect_err("expected panic");
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(code), "expected {code}, got {msg}");
}

// Each blocked case builds a fresh guard inside the closure so state is never shared.
fn blocked<F: FnOnce(&mut Guard) + std::panic::UnwindSafe>(code: &str, f: F) {
    panics(
        move || {
            let mut g = setup();
            f(&mut g)
        },
        code,
    );
}

#[test]
fn init_requires_owner_or_self() {
    panics(
        || {
            set(bob(), T0, 0);
            Guard::new(owner(), vec![usdc()]);
        },
        "E_INIT_NOT_OWNER",
    );
    set(guard_id(), T0, 0);
    let g = Guard::new(owner(), vec![usdc()]);
    assert_eq!(g.get_owner(), owner());
}

#[test]
fn happy_spend_debits_budget_and_counts_today() {
    let mut g = setup();
    spend(&mut g, 7, 1);
    assert_eq!(g.get_budget(usdc()).0, 93);
    assert_eq!(g.get_spent_today(agent(), usdc()).0, 7);
    assert_eq!(g.get_policy(agent()).unwrap().last_nonce.0, 1);
    set_with_result(T0, PromiseResult::Successful(vec![]));
    assert!(g.on_spend_complete(
        Ok(()),
        agent(),
        usdc(),
        bob(),
        U128(7),
        U64(T0 / DAY),
        U64(1),
        None
    ));
    let logs = get_logs();
    assert!(logs[0].starts_with("EVENT_JSON:"));
    assert!(logs[0].contains("\"event\":\"spend\""));
    assert!(logs[0].contains("\"standard\":\"penny_guard\""));
}

#[test]
fn over_per_tx_cap() {
    blocked("E_OVER_TX_CAP", |g| spend(g, 11, 1));
}

#[test]
fn over_daily_cap() {
    blocked("E_OVER_DAILY_CAP", |g| {
        spend(g, 10, 1);
        spend(g, 10, 2);
        spend(g, 6, 3); // 26 > 25
    });
}

#[test]
fn daily_window_resets_at_utc_midnight() {
    let mut g = setup();
    let day_start = (T0 / DAY) * DAY;
    for (amt, n) in [(10, 1), (10, 2), (5, 3)] {
        set(agent(), day_start + DAY - 1, 0);
        let _ = g.spend(usdc(), bob(), U128(amt), None, U64(n));
    }
    assert_eq!(g.get_spent_today(agent(), usdc()).0, 25);
    set(agent(), day_start + DAY, 0); // next UTC day
    assert_eq!(g.get_spent_today(agent(), usdc()).0, 0);
    let _ = g.spend(usdc(), bob(), U128(10), None, U64(4));
    assert_eq!(g.get_spent_today(agent(), usdc()).0, 10);
    assert_eq!(g.get_budget(usdc()).0, 65);
}

#[test]
fn non_allowlisted_recipient() {
    blocked("E_NOT_ALLOWLISTED", |g| {
        set(owner(), T0, 1);
        g.set_policy(
            agent(),
            PolicyInput {
                limits: limits(10, 25),
                allowlist: vec![a("ada.near")],
                expires_at: None,
            },
        );
        spend(g, 1, 1);
    });
}

#[test]
fn allowlisted_recipient_passes() {
    let mut g = setup();
    set(owner(), T0, 1);
    g.set_policy(
        agent(),
        PolicyInput {
            limits: limits(10, 25),
            allowlist: vec![bob()],
            expires_at: None,
        },
    );
    spend(&mut g, 1, 1);
    assert_eq!(g.get_budget(usdc()).0, 99);
}

#[test]
fn paused_agent() {
    blocked("E_PAUSED", |g| {
        set(owner(), T0, 0);
        g.pause_agent(agent());
        spend(g, 1, 1);
    });
}

#[test]
fn pause_all_and_resume() {
    blocked("E_PAUSED_ALL", |g| {
        set(owner(), T0, 0);
        g.pause_all();
        spend(g, 1, 1);
    });
    let mut g = setup();
    set(owner(), T0, 0);
    g.pause_all();
    set(owner(), T0, 1);
    g.resume_all();
    spend(&mut g, 1, 1);
}

#[test]
fn resume_needs_one_yocto() {
    blocked("E_ONE_YOCTO", |g| {
        set(owner(), T0, 0);
        g.pause_agent(agent());
        g.resume_agent(agent());
    });
}

#[test]
fn revoked_agent() {
    blocked("E_REVOKED", |g| {
        set(owner(), T0, 0);
        g.revoke_agent(agent());
        spend(g, 1, 1);
    });
}

#[test]
fn revoke_then_readd_keeps_nonce() {
    let mut g = setup();
    spend(&mut g, 1, 5);
    set(owner(), T0, 0);
    g.revoke_agent(agent());
    set(owner(), T0, 1);
    g.set_policy(
        agent(),
        PolicyInput {
            limits: limits(10, 25),
            allowlist: vec![],
            expires_at: None,
        },
    );
    assert_eq!(g.get_policy(agent()).unwrap().last_nonce.0, 5);
    panics(
        move || {
            let mut g2 = g;
            spend(&mut g2, 1, 5)
        },
        "E_NONCE",
    );
}

#[test]
fn expired_policy() {
    blocked("E_EXPIRED", |g| {
        set(owner(), T0, 1);
        g.set_policy(
            agent(),
            PolicyInput {
                limits: limits(10, 25),
                allowlist: vec![],
                expires_at: Some(U64(T0 + 10)),
            },
        );
        set(agent(), T0 + 10, 0);
        let _ = g.spend(usdc(), bob(), U128(1), None, U64(1));
    });
}

#[test]
fn replay_nonce() {
    blocked("E_NONCE", |g| {
        spend(g, 1, 1);
        spend(g, 1, 1);
    });
    blocked("E_NONCE", |g| {
        spend(g, 1, 5);
        spend(g, 1, 4);
    });
}

#[test]
fn unknown_agent() {
    blocked("E_NO_POLICY", |g| {
        set(bob(), T0, 0);
        let _ = g.spend(usdc(), a("x.near"), U128(1), None, U64(1));
    });
}

#[test]
fn token_not_in_agent_policy() {
    blocked("E_TOKEN_NOT_ALLOWED", |g| {
        set(agent(), T0, 0);
        let _ = g.spend(wnear(), bob(), U128(1), None, U64(1));
    });
}

#[test]
fn over_budget() {
    blocked("E_BUDGET", |g| {
        set(owner(), T0, 1);
        g.set_policy(
            agent(),
            PolicyInput {
                limits: limits(200, 200),
                allowlist: vec![],
                expires_at: None,
            },
        );
        spend(g, 101, 1);
    });
}

#[test]
fn not_enough_gas() {
    blocked("E_GAS", |g| {
        testing_env!(ctx(agent(), T0, 0).prepaid_gas(Gas::from_tgas(30)).build());
        let _ = g.spend(usdc(), bob(), U128(1), None, U64(1));
    });
}

#[test]
fn non_owner_set_policy() {
    blocked("E_NOT_OWNER", |g| {
        set(agent(), T0, 1);
        g.set_policy(
            agent(),
            PolicyInput {
                limits: limits(1000, 1000),
                allowlist: vec![],
                expires_at: None,
            },
        );
    });
}

#[test]
fn set_policy_needs_one_yocto() {
    blocked("E_ONE_YOCTO", |g| {
        set(owner(), T0, 0);
        g.set_policy(
            agent(),
            PolicyInput {
                limits: limits(1, 1),
                allowlist: vec![],
                expires_at: None,
            },
        );
    });
}

#[test]
fn set_policy_validates() {
    blocked("E_CAP_ORDER", |g| {
        set(owner(), T0, 1);
        g.set_policy(
            agent(),
            PolicyInput {
                limits: limits(5, 4),
                allowlist: vec![],
                expires_at: None,
            },
        );
    });
    blocked("E_TOKEN", |g| {
        set(owner(), T0, 1);
        g.set_policy(
            agent(),
            PolicyInput {
                limits: vec![TokenLimit {
                    token: a("evil.near"),
                    per_tx_cap: U128(1),
                    daily_cap: U128(1),
                }],
                allowlist: vec![],
                expires_at: None,
            },
        );
    });
    blocked("E_AGENT_ID", |g| {
        set(owner(), T0, 1);
        g.set_policy(
            owner(),
            PolicyInput {
                limits: limits(1, 1),
                allowlist: vec![],
                expires_at: None,
            },
        );
    });
    blocked("E_EXPIRES_PAST", |g| {
        set(owner(), T0, 1);
        g.set_policy(
            agent(),
            PolicyInput {
                limits: limits(1, 1),
                allowlist: vec![],
                expires_at: Some(U64(T0)),
            },
        );
    });
}

#[test]
fn non_owner_pause_and_revoke() {
    blocked("E_NOT_OWNER", |g| {
        set(agent(), T0, 0);
        g.pause_agent(agent());
    });
    blocked("E_NOT_OWNER", |g| {
        set(bob(), T0, 0);
        g.revoke_agent(agent());
    });
}

#[test]
fn failed_transfer_restores_budget_and_spent() {
    let mut g = setup();
    spend(&mut g, 8, 1);
    assert_eq!(g.get_budget(usdc()).0, 92);
    set_with_result(T0, PromiseResult::Failed);
    let ok = g.on_spend_complete(
        Err(PromiseError::Failed),
        agent(),
        usdc(),
        bob(),
        U128(8),
        U64(T0 / DAY),
        U64(1),
        None,
    );
    assert!(!ok);
    assert_eq!(g.get_budget(usdc()).0, 100);
    assert_eq!(g.get_spent_today(agent(), usdc()).0, 0);
    assert!(get_logs()[0].contains("spend_failed"));
    // nonce stays consumed
    assert_eq!(g.get_policy(agent()).unwrap().last_nonce.0, 1);
}

#[test]
fn failed_transfer_after_midnight_does_not_touch_new_day() {
    let mut g = setup();
    spend(&mut g, 8, 1);
    let next = (T0 / DAY + 1) * DAY;
    set(agent(), next, 0);
    let _ = g.spend(usdc(), bob(), U128(3), None, U64(2));
    set_with_result(next, PromiseResult::Failed);
    g.on_spend_complete(
        Err(PromiseError::Failed),
        agent(),
        usdc(),
        bob(),
        U128(8),
        U64(T0 / DAY),
        U64(1),
        None,
    );
    assert_eq!(g.get_spent_today(agent(), usdc()).0, 3);
    assert_eq!(g.get_budget(usdc()).0, 97);
}

#[test]
fn withdraw_owner_only() {
    blocked("E_NOT_OWNER", |g| {
        set(agent(), T0, 1);
        let _ = g.withdraw(usdc(), U128(1));
    });
    blocked("E_ONE_YOCTO", |g| {
        set(owner(), T0, 0);
        let _ = g.withdraw(usdc(), U128(1));
    });
    blocked("E_BUDGET", |g| {
        set(owner(), T0, 1);
        let _ = g.withdraw(usdc(), U128(101));
    });
    let mut g = setup();
    set(owner(), T0, 1);
    let _ = g.withdraw(usdc(), U128(40));
    assert_eq!(g.get_budget(usdc()).0, 60);
    set_with_result(T0, PromiseResult::Failed);
    g.on_withdraw_complete(Err(PromiseError::Failed), usdc(), U128(40));
    assert_eq!(g.get_budget(usdc()).0, 100);
}

#[test]
fn ft_on_transfer_from_stranger_or_unknown_token_refunds() {
    let mut g = setup();
    set(usdc(), T0, 0);
    let r = g.ft_on_transfer(bob(), U128(50), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(50))));
    set(a("fake-usdc.near"), T0, 0);
    let r = g.ft_on_transfer(owner(), U128(50), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(50))));
    assert_eq!(g.get_budget(usdc()).0, 100);
    assert_eq!(g.get_budget(a("fake-usdc.near")).0, 0);
}

#[test]
fn add_token_owner_only() {
    let mut g = setup();
    set(owner(), T0, 1);
    g.add_token(a("usdt.near"));
    assert_eq!(g.get_tokens().len(), 3);
    blocked("E_NOT_OWNER", |g| {
        set(bob(), T0, 1);
        g.add_token(a("x.near"));
    });
}

#[test]
fn utc_day_boundaries() {
    assert_eq!(utc_day(0), 0);
    assert_eq!(utc_day(DAY - 1), 0);
    assert_eq!(utc_day(DAY), 1);
}
