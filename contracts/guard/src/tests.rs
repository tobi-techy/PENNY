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
    a("guard.penny.near")
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
fn owner_b() -> AccountId {
    a("ada.penny.near")
}
fn agent_b() -> AccountId {
    a("mail.penny.near")
}
fn deployer() -> AccountId {
    a("penny.near")
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
    set(deployer(), T0, 0);
    let mut g = Guard::new(vec![usdc(), wnear()]);
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
    let _ = g.spend(owner(), usdc(), bob(), U128(amount), None, U64(nonce));
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
fn init_allowed_for_parent_and_self_only() {
    for pred in [bob(), owner(), a("near"), a("xpenny.near")] {
        panics(
            move || {
                set(pred, T0, 0);
                Guard::new(vec![usdc()]);
            },
            "E_INIT_NOT_ALLOWED",
        );
    }
    set(guard_id(), T0, 0);
    let g = Guard::new(vec![usdc()]);
    assert_eq!(g.get_tokens(), vec![usdc()]);
    set(deployer(), T0, 0);
    let g = Guard::new(vec![usdc(), wnear()]);
    assert_eq!(g.get_tokens(), vec![usdc(), wnear()]);
}

#[test]
fn init_validates_tokens() {
    panics(
        || {
            set(deployer(), T0, 0);
            Guard::new(vec![]);
        },
        "E_TOKENS_LEN",
    );
    panics(
        || {
            set(deployer(), T0, 0);
            Guard::new((0..9).map(|i| a(&format!("t{i}.near"))).collect());
        },
        "E_TOKENS_LEN",
    );
    panics(
        || {
            set(deployer(), T0, 0);
            Guard::new(vec![usdc(), usdc()]);
        },
        "E_TOKENS_DUP",
    );
}

#[test]
fn happy_spend_debits_budget_and_counts_today() {
    let mut g = setup();
    spend(&mut g, 7, 1);
    assert_eq!(g.get_budget(owner(), usdc()).0, 93);
    assert_eq!(g.get_spent_today(owner(), agent(), usdc()).0, 7);
    assert_eq!(g.get_policy(owner(), agent()).unwrap().last_nonce.0, 1);
    set_with_result(T0, PromiseResult::Successful(vec![]));
    assert!(g.on_spend_complete(
        Ok(()),
        owner(),
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
        let _ = g.spend(owner(), usdc(), bob(), U128(amt), None, U64(n));
    }
    assert_eq!(g.get_spent_today(owner(), agent(), usdc()).0, 25);
    set(agent(), day_start + DAY, 0); // next UTC day
    assert_eq!(g.get_spent_today(owner(), agent(), usdc()).0, 0);
    let _ = g.spend(owner(), usdc(), bob(), U128(10), None, U64(4));
    assert_eq!(g.get_spent_today(owner(), agent(), usdc()).0, 10);
    assert_eq!(g.get_budget(owner(), usdc()).0, 65);
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
    assert_eq!(g.get_budget(owner(), usdc()).0, 99);
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
    assert_eq!(g.get_policy(owner(), agent()).unwrap().last_nonce.0, 5);
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
        let _ = g.spend(owner(), usdc(), bob(), U128(1), None, U64(1));
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
        let _ = g.spend(owner(), usdc(), a("x.near"), U128(1), None, U64(1));
    });
}

#[test]
fn token_not_in_agent_policy() {
    blocked("E_TOKEN_NOT_ALLOWED", |g| {
        set(agent(), T0, 0);
        let _ = g.spend(owner(), wnear(), bob(), U128(1), None, U64(1));
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
        let _ = g.spend(owner(), usdc(), bob(), U128(1), None, U64(1));
    });
}

#[test]
fn agent_cannot_set_policy_for_itself() {
    blocked("E_AGENT_ID", |g| {
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
fn stranger_pause_and_revoke_only_see_their_own_scope() {
    blocked("E_NO_POLICY", |g| {
        set(agent(), T0, 0);
        g.pause_agent(agent());
    });
    blocked("E_NO_POLICY", |g| {
        set(bob(), T0, 0);
        g.revoke_agent(agent());
    });
    blocked("E_NO_POLICY", |g| {
        set(bob(), T0, 1);
        g.resume_agent(agent());
    });
    // bob pausing everything for himself does not pause tobi's agent
    let mut g = setup();
    set(bob(), T0, 0);
    g.pause_all();
    assert!(g.is_paused_all(bob()));
    assert!(!g.is_paused_all(owner()));
    spend(&mut g, 1, 1);
    assert_eq!(g.get_budget(owner(), usdc()).0, 99);
}

#[test]
fn failed_transfer_restores_budget_and_spent() {
    let mut g = setup();
    spend(&mut g, 8, 1);
    assert_eq!(g.get_budget(owner(), usdc()).0, 92);
    set_with_result(T0, PromiseResult::Failed);
    let ok = g.on_spend_complete(
        Err(PromiseError::Failed),
        owner(),
        agent(),
        usdc(),
        bob(),
        U128(8),
        U64(T0 / DAY),
        U64(1),
        None,
    );
    assert!(!ok);
    assert_eq!(g.get_budget(owner(), usdc()).0, 100);
    assert_eq!(g.get_spent_today(owner(), agent(), usdc()).0, 0);
    assert!(get_logs()[0].contains("spend_failed"));
    // nonce stays consumed
    assert_eq!(g.get_policy(owner(), agent()).unwrap().last_nonce.0, 1);
}

#[test]
fn failed_transfer_after_midnight_does_not_touch_new_day() {
    let mut g = setup();
    spend(&mut g, 8, 1);
    let next = (T0 / DAY + 1) * DAY;
    set(agent(), next, 0);
    let _ = g.spend(owner(), usdc(), bob(), U128(3), None, U64(2));
    set_with_result(next, PromiseResult::Failed);
    g.on_spend_complete(
        Err(PromiseError::Failed),
        owner(),
        agent(),
        usdc(),
        bob(),
        U128(8),
        U64(T0 / DAY),
        U64(1),
        None,
    );
    assert_eq!(g.get_spent_today(owner(), agent(), usdc()).0, 3);
    assert_eq!(g.get_budget(owner(), usdc()).0, 97);
}

#[test]
fn withdraw_checks() {
    blocked("E_BUDGET", |g| {
        set(agent(), T0, 1);
        let _ = g.withdraw(usdc(), U128(1));
    });
    blocked("E_ZERO", |g| {
        set(owner(), T0, 1);
        let _ = g.withdraw(usdc(), U128(0));
    });
    blocked("E_GAS", |g| {
        testing_env!(ctx(owner(), T0, 1).prepaid_gas(Gas::from_tgas(30)).build());
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
    assert_eq!(g.get_budget(owner(), usdc()).0, 60);
    set_with_result(T0, PromiseResult::Failed);
    g.on_withdraw_complete(Err(PromiseError::Failed), owner(), usdc(), U128(40));
    assert_eq!(g.get_budget(owner(), usdc()).0, 100);
}

#[test]
fn ft_on_transfer_unknown_token_or_zero_refunds() {
    let mut g = setup();
    set(a("fake-usdc.near"), T0, 0);
    let r = g.ft_on_transfer(owner(), U128(50), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(50))));
    set(usdc(), T0, 0);
    let r = g.ft_on_transfer(owner(), U128(0), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(g.get_budget(owner(), usdc()).0, 100);
    assert_eq!(g.get_budget(owner(), a("fake-usdc.near")).0, 0);
    // a refunded transfer never applies msg policies
    set(a("fake-usdc.near"), T0, 0);
    let _ = g.ft_on_transfer(owner_b(), U128(5), policies_msg(&agent_b(), 1, 1));
    assert!(g.get_policy(owner_b(), agent_b()).is_none());
}

#[test]
fn ft_on_transfer_credits_the_sender_only() {
    let mut g = setup();
    set(usdc(), T0, 0);
    let r = g.ft_on_transfer(bob(), U128(50), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(g.get_budget(bob(), usdc()).0, 50);
    assert_eq!(g.get_budget(owner(), usdc()).0, 100);
    assert!(get_logs()[0].contains("\"owner_id\":\"bob.near\""));
}

fn policies_msg(agent_id: &AccountId, per_tx: u128, daily: u128) -> String {
    serde_json::json!({"policies": [{"agent_id": agent_id, "policy": {
        "limits": [{"token": usdc(), "per_tx_cap": per_tx.to_string(),
                    "daily_cap": daily.to_string()}]
    }}]})
    .to_string()
}

#[test]
fn ft_on_transfer_with_policies_msg_funds_and_sets_policies() {
    let mut g = setup();
    set(usdc(), T0, 0);
    let msg = serde_json::json!({"policies": [
        {"agent_id": agent_b(), "policy": {
            "limits": [{"token": usdc(), "per_tx_cap": "5", "daily_cap": "20"}],
            "allowlist": [bob()]}},
        {"agent_id": agent(), "policy": {
            "limits": [{"token": usdc(), "per_tx_cap": "3", "daily_cap": "3"}],
            "expires_at": (T0 + DAY).to_string()}}
    ]})
    .to_string();
    let r = g.ft_on_transfer(owner_b(), U128(30), msg);
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(g.get_budget(owner_b(), usdc()).0, 30);
    let p = g.get_policy(owner_b(), agent_b()).unwrap();
    assert_eq!(p.owner_id, owner_b());
    assert_eq!(p.limits[0].per_tx_cap.0, 5);
    assert_eq!(p.allowlist, vec![bob()]);
    let p = g.get_policy(owner_b(), agent()).unwrap();
    assert_eq!(p.expires_at, Some(U64(T0 + DAY)));
    assert_eq!(g.get_agents(owner_b()).len(), 2);
    // owner A's policy for the same agent is untouched
    assert_eq!(g.get_policy(owner(), agent()).unwrap().limits[0].per_tx_cap.0, 10);
    // the msg-set policy works
    set(agent_b(), T0, 0);
    let _ = g.spend(owner_b(), usdc(), bob(), U128(5), None, U64(1));
    assert_eq!(g.get_budget(owner_b(), usdc()).0, 25);
}

#[test]
fn ft_on_transfer_invalid_msg_panics() {
    let cases: Vec<(String, &str)> = vec![
        (policies_msg(&agent_b(), 5, 4), "E_CAP_ORDER"),
        (policies_msg(&agent_b(), 0, 4), "E_CAP_ZERO"),
        (policies_msg(&owner_b(), 1, 1), "E_AGENT_ID"),
        ("not json".to_string(), "E_MSG"),
        ("{\"policy\":[]}".to_string(), "E_MSG"),
        (
            serde_json::json!({"policies": (0..9).map(|i| serde_json::json!({
                "agent_id": format!("a{i}.near"),
                "policy": {"limits": [{"token": usdc(), "per_tx_cap": "1", "daily_cap": "1"}]}
            })).collect::<Vec<_>>()})
            .to_string(),
            "E_MSG_LEN",
        ),
    ];
    for (msg, code) in cases {
        blocked(code, move |g| {
            set(usdc(), T0, 0);
            let _ = g.ft_on_transfer(owner_b(), U128(30), msg);
        });
    }
}

/// Owner B funds 5 USDC and gives `agent()` (also used by owner A) and `agent_b()` policies.
fn setup_two_owners() -> Guard {
    let mut g = setup();
    set(usdc(), T0, 0);
    let _ = g.ft_on_transfer(owner_b(), U128(5), String::new());
    for ag in [agent(), agent_b()] {
        set(owner_b(), T0, 1);
        g.set_policy(
            ag,
            PolicyInput {
                limits: limits(10, 25),
                allowlist: vec![],
                expires_at: None,
            },
        );
    }
    g
}

#[test]
fn agent_cannot_spend_another_owners_budget() {
    // owner B's agent has no policy from owner A
    panics(
        || {
            let mut g = setup_two_owners();
            set(agent_b(), T0, 0);
            let _ = g.spend(owner(), usdc(), bob(), U128(1), None, U64(1));
        },
        "E_NO_POLICY",
    );
    // spending via owner B only reaches owner B's budget, not A's 100
    panics(
        || {
            let mut g = setup_two_owners();
            set(agent(), T0, 0);
            let _ = g.spend(owner_b(), usdc(), bob(), U128(6), None, U64(1));
        },
        "E_BUDGET",
    );
    // an agent of A with no policy from B
    panics(
        || {
            let mut g = setup();
            set(agent(), T0, 0);
            let _ = g.spend(owner_b(), usdc(), bob(), U128(1), None, U64(1));
        },
        "E_NO_POLICY",
    );
    let mut g = setup_two_owners();
    set(agent(), T0, 0);
    let _ = g.spend(owner_b(), usdc(), bob(), U128(5), None, U64(1));
    assert_eq!(g.get_budget(owner_b(), usdc()).0, 0);
    assert_eq!(g.get_budget(owner(), usdc()).0, 100);
    assert_eq!(g.get_spent_today(owner_b(), agent(), usdc()).0, 5);
    assert_eq!(g.get_spent_today(owner(), agent(), usdc()).0, 0);
    // nonces are per (owner, agent)
    assert_eq!(g.get_policy(owner(), agent()).unwrap().last_nonce.0, 0);
    let _ = g.spend(owner(), usdc(), bob(), U128(1), None, U64(1));
    assert_eq!(g.get_budget(owner(), usdc()).0, 99);
}

#[test]
fn pause_and_revoke_are_scoped_to_the_owner() {
    let mut g = setup_two_owners();
    set(owner(), T0, 0);
    g.pause_agent(agent());
    set(agent(), T0, 0);
    let _ = g.spend(owner_b(), usdc(), bob(), U128(1), None, U64(1));
    assert!(g.get_policy(owner(), agent()).unwrap().paused);
    assert!(!g.get_policy(owner_b(), agent()).unwrap().paused);

    set(owner(), T0, 0);
    g.revoke_agent(agent());
    g.pause_all();
    set(agent(), T0, 0);
    let _ = g.spend(owner_b(), usdc(), bob(), U128(1), None, U64(2));
    assert!(!g.is_paused_all(owner_b()));
    assert!(!g.get_policy(owner_b(), agent()).unwrap().revoked);
    assert_eq!(g.get_budget(owner_b(), usdc()).0, 3);

    set(owner_b(), T0, 0);
    g.pause_all();
    panics(
        move || {
            let mut g = g;
            set(agent_b(), T0, 0);
            let _ = g.spend(owner_b(), usdc(), bob(), U128(1), None, U64(1));
        },
        "E_PAUSED_ALL",
    );
}

#[test]
fn withdraw_only_touches_callers_budget() {
    let mut g = setup_two_owners();
    set(owner_b(), T0, 1);
    let _ = g.withdraw(usdc(), U128(5));
    assert_eq!(g.get_budget(owner_b(), usdc()).0, 0);
    assert_eq!(g.get_budget(owner(), usdc()).0, 100);
    panics(
        move || {
            let mut g = g;
            set(owner_b(), T0, 1);
            let _ = g.withdraw(usdc(), U128(1));
        },
        "E_BUDGET",
    );
}

#[test]
fn rollback_restores_the_right_owner() {
    let mut g = setup_two_owners();
    spend(&mut g, 8, 1); // owner A
    set(agent(), T0, 0);
    let _ = g.spend(owner_b(), usdc(), bob(), U128(4), None, U64(1));
    assert_eq!(g.get_budget(owner(), usdc()).0, 92);
    assert_eq!(g.get_budget(owner_b(), usdc()).0, 1);
    set_with_result(T0, PromiseResult::Failed);
    g.on_spend_complete(
        Err(PromiseError::Failed),
        owner_b(),
        agent(),
        usdc(),
        bob(),
        U128(4),
        U64(T0 / DAY),
        U64(1),
        None,
    );
    let log = &get_logs()[0];
    assert!(log.contains("spend_failed") && log.contains("\"owner_id\":\"ada.penny.near\""));
    assert_eq!(g.get_budget(owner_b(), usdc()).0, 5);
    assert_eq!(g.get_spent_today(owner_b(), agent(), usdc()).0, 0);
    assert_eq!(g.get_budget(owner(), usdc()).0, 92);
    assert_eq!(g.get_spent_today(owner(), agent(), usdc()).0, 8);

    set(owner_b(), T0, 1);
    let _ = g.withdraw(usdc(), U128(5));
    set_with_result(T0, PromiseResult::Failed);
    g.on_withdraw_complete(Err(PromiseError::Failed), owner_b(), usdc(), U128(5));
    assert_eq!(g.get_budget(owner_b(), usdc()).0, 5);
    assert_eq!(g.get_budget(owner(), usdc()).0, 92);
}

#[test]
fn agent_list_is_tracked_and_bounded() {
    let mut g = setup();
    let agents = g.get_agents(owner());
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].agent_id, agent());
    // replacing a policy does not add a second entry
    set(owner(), T0, 1);
    g.set_policy(
        agent(),
        PolicyInput {
            limits: limits(1, 1),
            allowlist: vec![],
            expires_at: None,
        },
    );
    assert_eq!(g.get_agents(owner()).len(), 1);
    for i in 1..MAX_AGENTS {
        g.set_policy(
            a(&format!("a{i}.near")),
            PolicyInput {
                limits: limits(1, 1),
                allowlist: vec![],
                expires_at: None,
            },
        );
    }
    assert_eq!(g.get_agents(owner()).len(), MAX_AGENTS);
    assert!(g.get_agents(owner_b()).is_empty());
    panics(
        move || {
            let mut g = g;
            set(owner(), T0, 1);
            g.set_policy(
                a("one-too-many.near"),
                PolicyInput {
                    limits: limits(1, 1),
                    allowlist: vec![],
                    expires_at: None,
                },
            );
        },
        "E_AGENTS_LEN",
    );
}

#[test]
fn set_policy_more_validation() {
    let p = |l: Vec<TokenLimit>, allow: Vec<AccountId>| PolicyInput {
        limits: l,
        allowlist: allow,
        expires_at: None,
    };
    let dup = vec![limits(1, 1)[0].clone(), limits(2, 2)[0].clone()];
    let many: Vec<TokenLimit> = (0..9)
        .map(|_| limits(1, 1)[0].clone())
        .collect();
    let big_allow: Vec<AccountId> = (0..65).map(|i| a(&format!("r{i}.near"))).collect();
    for (agent_id, policy, code) in [
        (guard_id(), p(limits(1, 1), vec![]), "E_AGENT_ID"),
        (agent(), p(vec![], vec![]), "E_LIMITS_LEN"),
        (agent(), p(many, vec![]), "E_LIMITS_LEN"),
        (agent(), p(dup, vec![]), "E_LIMITS_DUP"),
        (agent(), p(limits(0, 1), vec![]), "E_CAP_ZERO"),
        (agent(), p(limits(1, 1), big_allow), "E_ALLOWLIST_LEN"),
    ] {
        blocked(code, move |g| {
            set(owner(), T0, 1);
            g.set_policy(agent_id, policy);
        });
    }
    blocked("E_ONE_YOCTO", |g| {
        set(owner(), T0, 2);
        g.set_policy(agent(), p(limits(1, 1), vec![]));
    });
}

#[test]
fn spend_input_checks() {
    blocked("E_ZERO", |g| spend(g, 0, 1));
    blocked("E_RECIPIENT", |g| {
        set(agent(), T0, 0);
        let _ = g.spend(owner(), usdc(), agent(), U128(1), None, U64(1));
    });
    blocked("E_RECIPIENT", |g| {
        set(agent(), T0, 0);
        let _ = g.spend(owner(), usdc(), guard_id(), U128(1), None, U64(1));
    });
    blocked("E_MEMO_LEN", |g| {
        set(agent(), T0, 0);
        let _ = g.spend(owner(), usdc(), bob(), U128(1), Some("x".repeat(129)), U64(1));
    });
    blocked("E_TOKEN", |g| {
        set(agent(), T0, 0);
        let _ = g.spend(owner(), a("x.near"), bob(), U128(1), None, U64(1));
    });
}

#[test]
fn resume_all_needs_one_yocto() {
    blocked("E_ONE_YOCTO", |g| {
        set(owner(), T0, 0);
        g.pause_all();
        g.resume_all();
    });
}

#[test]
fn spend_event_includes_owner() {
    let mut g = setup();
    spend(&mut g, 1, 1);
    set_with_result(T0, PromiseResult::Successful(vec![]));
    g.on_spend_complete(
        Ok(()),
        owner(),
        agent(),
        usdc(),
        bob(),
        U128(1),
        U64(T0 / DAY),
        U64(1),
        Some("lunch".into()),
    );
    let log = &get_logs()[0];
    assert!(log.contains("\"owner_id\":\"tobi.penny.near\""));
    assert!(log.contains("\"agent_id\":\"invest.penny.near\""));
    assert!(log.contains("\"memo\":\"lunch\""));
}

#[test]
fn utc_day_boundaries() {
    assert_eq!(utc_day(0), 0);
    assert_eq!(utc_day(DAY - 1), 0);
    assert_eq!(utc_day(DAY), 1);
}

#[test]
fn set_policy_without_budget_fails() {
    // brand-new owner, nothing funded
    blocked("E_NO_BUDGET", |g| {
        set(owner_b(), T0, 1);
        g.set_policy(
            agent_b(),
            PolicyInput {
                limits: limits(1, 1),
                allowlist: vec![],
                expires_at: None,
            },
        );
    });
    // funded in wNEAR only, but the policy only names USDC
    blocked("E_NO_BUDGET", |g| {
        set(wnear(), T0, 0);
        let _ = g.ft_on_transfer(owner_b(), U128(5), String::new());
        set(owner_b(), T0, 1);
        g.set_policy(
            agent_b(),
            PolicyInput {
                limits: limits(1, 1),
                allowlist: vec![],
                expires_at: None,
            },
        );
    });
    // withdrawn to zero: replacing a policy now fails too
    blocked("E_NO_BUDGET", |g| {
        set(owner(), T0, 1);
        let _ = g.withdraw(usdc(), U128(100));
        g.set_policy(
            agent(),
            PolicyInput {
                limits: limits(1, 1),
                allowlist: vec![],
                expires_at: None,
            },
        );
    });
    // via msg on a refunded (zero-amount) transfer: msg ignored, so no policy either
    let mut g = setup();
    set(usdc(), T0, 0);
    let _ = g.ft_on_transfer(owner_b(), U128(0), policies_msg(&agent_b(), 1, 1));
    assert!(g.get_policy(owner_b(), agent_b()).is_none());
}

#[test]
fn ft_on_transfer_policies_msg_works_for_brand_new_owner() {
    let mut g = setup();
    let fresh = a("newbie.penny.near");
    assert_eq!(g.get_budget(fresh.clone(), usdc()).0, 0);
    set(usdc(), T0, 0);
    let r = g.ft_on_transfer(fresh.clone(), U128(1), policies_msg(&agent_b(), 1, 1));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(g.get_budget(fresh.clone(), usdc()).0, 1);
    assert!(g.get_policy(fresh.clone(), agent_b()).is_some());
    // funding a token the msg policy does not name does not count
    panics(
        move || {
            let mut g = g;
            set(wnear(), T0, 0);
            let _ = g.ft_on_transfer(a("other.penny.near"), U128(1), policies_msg(&agent_b(), 1, 1));
        },
        "E_NO_BUDGET",
    );
}

#[test]
fn pause_and_revoke_work_at_zero_budget() {
    let mut g = setup();
    set(owner(), T0, 1);
    let _ = g.withdraw(usdc(), U128(100));
    assert_eq!(g.get_budget(owner(), usdc()).0, 0);
    set(owner(), T0, 0);
    g.pause_agent(agent());
    assert!(g.get_policy(owner(), agent()).unwrap().paused);
    g.pause_all();
    assert!(g.is_paused_all(owner()));
    g.revoke_agent(agent());
    assert!(g.get_policy(owner(), agent()).unwrap().revoked);
    set(owner(), T0, 1);
    g.resume_all();
    assert!(!g.is_paused_all(owner()));
}
