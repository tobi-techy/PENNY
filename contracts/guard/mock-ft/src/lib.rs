//! Penny test dollar (tUSD): a NEP-141 + NEP-145 token with 6 decimals that stands in for
//! USDC in sandbox tests and on testnet. The owner can `mint` freely. Never deploy to mainnet.
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%2316a34a'/%3E%3Ctext x='16' y='22' font-size='18' text-anchor='middle' fill='white' font-family='sans-serif'%3Et$%3C/text%3E%3C/svg%3E";

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    token: FungibleToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut token = FungibleToken::new(b"t".to_vec());
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        Self { owner_id, token }
    }

    /// Owner only. Registers `account_id` with the token if needed (storage paid by the
    /// contract), then mints `amount` base units (6 decimals) to it.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "E_NOT_OWNER"
        );
        require!(amount.0 > 0, "E_ZERO");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("tUSD mint"),
        }
        .emit();
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }
    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }
    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Penny Test Dollar".to_string(),
            symbol: "tUSD".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn set(pred: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("tusd.penny.testnet".parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .build());
    }

    #[test]
    fn mint_registers_and_credits_owner_only() {
        set("penny.testnet");
        let mut c = Contract::new("penny.testnet".parse().unwrap(), U128(1_000_000));
        let ada: AccountId = "ada.testnet".parse().unwrap();
        assert!(c.storage_balance_of(ada.clone()).is_none());
        c.mint(ada.clone(), U128(5_000_000));
        assert_eq!(c.ft_balance_of(ada.clone()).0, 5_000_000);
        assert!(c.storage_balance_of(ada.clone()).is_some());
        assert_eq!(c.ft_total_supply().0, 6_000_000);
        c.mint(ada.clone(), U128(1));
        assert_eq!(c.ft_balance_of(ada.clone()).0, 5_000_001);
        let m = c.ft_metadata();
        assert_eq!((m.symbol.as_str(), m.decimals), ("tUSD", 6));

        set("ada.testnet");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.mint(ada.clone(), U128(1))
        }));
        assert!(r.is_err());
    }
}
