//! Account groups and helpers shared by every instruction that touches a launch's Phoenix
//! account: deploying collateral, deleveraging, redeeming and funding claims.
use anchor_lang::prelude::*;
use anchor_spl::{token::Token, token_interface::TokenAccount};

use crate::{
    constants::*,
    error::VaultError,
    math,
    phoenix::{self, Ember, Exchange, Fill, PerpView, Phoenix, TraderHeader, Views},
    state::{Direction, Launch},
};

/// Phoenix accounts of a launch operation.
#[derive(Accounts)]
pub struct PhoenixAccounts<'info> {
    /// CHECK: address-constrained
    #[account(address = phoenix::PHOENIX_PROGRAM_ID)]
    pub phoenix_program: UncheckedAccount<'info>,
    /// CHECK: address-constrained
    #[account(address = phoenix::PHOENIX_LOG_AUTHORITY)]
    pub log_authority: UncheckedAccount<'info>,
    /// CHECK: address-constrained, parsed in the handler
    #[account(mut, address = phoenix::PHOENIX_GLOBAL_CONFIG)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: the launch's own trader account, checked in the handler
    #[account(mut)]
    pub trader_account: UncheckedAccount<'info>,
    /// CHECK: checked against the Phoenix global configuration
    #[account(mut)]
    pub perp_asset_map: UncheckedAccount<'info>,
    /// CHECK: the launch's market, checked in the handler
    #[account(mut)]
    pub orderbook: UncheckedAccount<'info>,
    /// CHECK: the launch's market, checked in the handler
    #[account(mut)]
    pub spline: UncheckedAccount<'info>,
    /// CHECK: checked against the Phoenix global configuration
    #[account(mut)]
    pub global_vault: UncheckedAccount<'info>,
    /// CHECK: checked against the Phoenix global configuration
    #[account(mut)]
    pub withdraw_queue: UncheckedAccount<'info>,
    /// CHECK: address-constrained
    #[account(address = phoenix::HAWKEYE_PROGRAM_ID)]
    pub hawkeye_program: UncheckedAccount<'info>,
}

/// Ember accounts plus the vault's two collateral token accounts.
#[derive(Accounts)]
pub struct EmberAccounts<'info> {
    /// CHECK: address-constrained
    #[account(address = phoenix::EMBER_PROGRAM_ID)]
    pub ember_program: UncheckedAccount<'info>,
    /// CHECK: address-constrained
    #[account(address = phoenix::EMBER_STATE)]
    pub ember_state: UncheckedAccount<'info>,
    /// CHECK: address-constrained
    #[account(mut, address = phoenix::EMBER_VAULT)]
    pub ember_vault: UncheckedAccount<'info>,
    /// CHECK: address-constrained
    #[account(address = USDC_MINT)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the Phoenix global configuration
    #[account(mut)]
    pub canonical_mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the launch's canonical token account; it does not exist before `register_trader`
    #[account(mut)]
    pub canonical_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Balance of a classic SPL token account, read straight from its data so it reflects CPIs made
/// earlier in the same instruction.
pub fn token_amount(info: &AccountInfo) -> Result<u64> {
    require_keys_eq!(
        *info.owner,
        anchor_spl::token::ID,
        VaultError::InvalidPhoenixAccount
    );
    let data = info.try_borrow_data()?;
    require!(data.len() >= 72, VaultError::InvalidPhoenixAccount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// One launch's Phoenix account, validated, with the operations the program performs on it.
pub struct Venue<'a, 'info> {
    pub launch: &'a Launch,
    pub launch_info: AccountInfo<'info>,
    pub phoenix: &'a PhoenixAccounts<'info>,
    pub ember: &'a EmberAccounts<'info>,
    pub tail: &'a [AccountInfo<'info>],
}

impl<'a, 'info> Venue<'a, 'info> {
    /// Pins every account to this launch and to the exchange's own configuration, which is what
    /// keeps one launch from touching another launch's trader account or vault.
    pub fn load(
        launch: &'a Account<'info, Launch>,
        phoenix: &'a PhoenixAccounts<'info>,
        ember: &'a EmberAccounts<'info>,
        tail: &'a [AccountInfo<'info>],
    ) -> Result<Self> {
        require!(
            launch.is_trader_registered(),
            VaultError::TraderNotRegistered
        );
        require_keys_eq!(
            ember.vault_usdc.key(),
            launch.vault_usdc,
            VaultError::InvalidPhoenixAccount
        );
        require_keys_eq!(
            ember.canonical_account.key(),
            launch.canonical_account,
            VaultError::InvalidPhoenixAccount
        );
        require_keys_eq!(
            phoenix.trader_account.key(),
            launch.trader_account,
            VaultError::InvalidPhoenixAccount
        );
        require_keys_eq!(
            phoenix.orderbook.key(),
            launch.orderbook,
            VaultError::InvalidPhoenixAccount
        );
        require_keys_eq!(
            phoenix.spline.key(),
            launch.spline,
            VaultError::InvalidPhoenixAccount
        );

        let exchange = Exchange::load(&phoenix.global_config)?;
        require_keys_eq!(
            phoenix.perp_asset_map.key(),
            exchange.perp_asset_map,
            VaultError::InvalidPhoenixAccount
        );
        require_keys_eq!(
            phoenix.global_vault.key(),
            exchange.global_vault,
            VaultError::InvalidPhoenixAccount
        );
        require_keys_eq!(
            phoenix.withdraw_queue.key(),
            exchange.withdraw_queue,
            VaultError::InvalidPhoenixAccount
        );
        require_keys_eq!(
            ember.canonical_mint.key(),
            exchange.canonical_mint,
            VaultError::InvalidPhoenixAccount
        );
        exchange.check_tail(tail)?;

        Ok(Self {
            launch,
            launch_info: launch.to_account_info(),
            phoenix,
            ember,
            tail,
        })
    }

    /// The part of the venue that values and trades the position.
    pub fn desk(&self) -> Desk<'_, 'info> {
        Desk {
            launch: self.launch,
            launch_info: self.launch_info.clone(),
            phoenix_program: &self.phoenix.phoenix_program,
            log_authority: &self.phoenix.log_authority,
            global_config: &self.phoenix.global_config,
            trader_account: &self.phoenix.trader_account,
            perp_asset_map: &self.phoenix.perp_asset_map,
            orderbook: &self.phoenix.orderbook,
            spline: &self.phoenix.spline,
            hawkeye_program: &self.phoenix.hawkeye_program,
            tail: self.tail,
        }
    }

    pub fn view(&self) -> Result<PerpView> {
        self.desk().view()
    }

    /// Orders and valuations of an open position use the mark, so the mark has to be recent.
    pub fn require_fresh_mark(&self) -> Result<()> {
        require!(self.desk().mark_is_fresh()?, VaultError::StaleMarkPrice);
        Ok(())
    }

    pub fn mark_is_fresh(&self) -> Result<bool> {
        self.desk().mark_is_fresh()
    }

    pub fn idle_usdc(&self) -> Result<u64> {
        token_amount(&self.ember.vault_usdc.to_account_info())
    }

    pub fn canonical(&self) -> Result<u64> {
        token_amount(&self.ember.canonical_account)
    }

    fn phoenix_cpi(&self) -> Phoenix<'_, 'info> {
        Phoenix {
            phoenix_program: &self.phoenix.phoenix_program,
            log_authority: &self.phoenix.log_authority,
            global_config: &self.phoenix.global_config,
            trader: &self.launch_info,
            trader_account: &self.phoenix.trader_account,
            tail: self.tail,
        }
    }

    fn ember_cpi<'b>(&'b self, vault_usdc: &'b AccountInfo<'info>) -> Ember<'b, 'info> {
        Ember {
            ember_program: &self.ember.ember_program,
            trader: &self.launch_info,
            ember_state: &self.ember.ember_state,
            usdc_mint: &self.ember.usdc_mint,
            canonical_mint: &self.ember.canonical_mint,
            trader_usdc: vault_usdc,
            trader_canonical: &self.ember.canonical_account,
            ember_vault: &self.ember.ember_vault,
            token_program: &self.ember.token_program,
        }
    }

    /// Vault USDC to Phoenix collateral.
    pub fn deposit(&self, amount: u64, seeds: &[&[u8]]) -> Result<()> {
        let vault_usdc = self.ember.vault_usdc.to_account_info();
        self.ember_cpi(&vault_usdc).deposit(amount, seeds)?;
        self.phoenix_cpi().deposit(
            &self.ember.canonical_account,
            &self.phoenix.global_vault,
            &self.ember.token_program,
            amount,
            seeds,
        )
    }

    /// See `Desk::order`.
    pub fn order(
        &self,
        increase: bool,
        base_lots: u64,
        mark_ticks: u64,
        seeds: &[&[u8]],
    ) -> Result<Fill> {
        self.desk().order(increase, base_lots, mark_ticks, seeds)
    }

    /// Canonical tokens in the vault to USDC in the vault.
    pub fn unwrap(&self, seeds: &[&[u8]]) -> Result<()> {
        if self.canonical()? == 0 {
            return Ok(());
        }
        let vault_usdc = self.ember.vault_usdc.to_account_info();
        self.ember_cpi(&vault_usdc).withdraw_all(seeds)
    }

    /// Asks Phoenix for `amount` of collateral and unwraps whatever arrives. Returns the USDC
    /// that reached the vault now: less than `amount` (usually zero) means Phoenix queued the
    /// withdrawal behind its exchange-wide budget. Only one may be queued per launch.
    pub fn withdraw(&self, amount: u64, seeds: &[&[u8]]) -> Result<u64> {
        require!(
            TraderHeader::load(&self.phoenix.trader_account)?.withdraw_queue_node == 0,
            VaultError::WithdrawalAlreadyQueued
        );
        let before = self.idle_usdc()?;
        self.phoenix_cpi().withdraw(
            &self.phoenix.perp_asset_map,
            &self.phoenix.global_vault,
            &self.ember.canonical_account,
            &self.ember.token_program,
            &self.phoenix.withdraw_queue,
            amount,
            seeds,
        )?;
        self.unwrap(seeds)?;
        Ok(self.idle_usdc()?.saturating_sub(before))
    }
}

/// One launch's position on Phoenix: its valuation and its orders.
pub struct Desk<'a, 'info> {
    pub launch: &'a Launch,
    pub launch_info: AccountInfo<'info>,
    pub phoenix_program: &'a AccountInfo<'info>,
    pub log_authority: &'a AccountInfo<'info>,
    pub global_config: &'a AccountInfo<'info>,
    pub trader_account: &'a AccountInfo<'info>,
    pub perp_asset_map: &'a AccountInfo<'info>,
    pub orderbook: &'a AccountInfo<'info>,
    pub spline: &'a AccountInfo<'info>,
    pub hawkeye_program: &'a AccountInfo<'info>,
    pub tail: &'a [AccountInfo<'info>],
}

impl<'a, 'info> Desk<'a, 'info> {
    fn views(&self) -> Views<'_, 'info> {
        Views {
            hawkeye_program: self.hawkeye_program,
            phoenix_program: self.phoenix_program,
            global_config: self.global_config,
            perp_asset_map: self.perp_asset_map,
            trader_account: self.trader_account,
            orderbook: self.orderbook,
            spline: self.spline,
            tail: self.tail,
        }
    }

    pub fn view(&self) -> Result<PerpView> {
        self.views().load(self.launch.asset_id)
    }

    pub fn mark_is_fresh(&self) -> Result<bool> {
        let updated = self.views().mark_updated_slot()?;
        Ok(Clock::get()?.slot.saturating_sub(updated) <= self.launch.max_mark_staleness_slots)
    }

    /// Immediate-or-cancel order whose limit the program sets itself: `order_slippage_bps` from
    /// `mark` on the taker's adverse side. `increase` buys for a long launch and sells for a
    /// short one; reductions are reduce-only.
    pub fn order(
        &self,
        increase: bool,
        base_lots: u64,
        mark_ticks: u64,
        seeds: &[&[u8]],
    ) -> Result<Fill> {
        let is_buy = (self.launch.direction == Direction::Long) == increase;
        let limit = math::limit_price(is_buy, mark_ticks, self.launch.order_slippage_bps);
        Phoenix {
            phoenix_program: self.phoenix_program,
            log_authority: self.log_authority,
            global_config: self.global_config,
            trader: &self.launch_info,
            trader_account: self.trader_account,
            tail: self.tail,
        }
        .place_ioc(
            self.perp_asset_map,
            self.orderbook,
            self.spline,
            is_buy,
            base_lots,
            limit,
            !increase,
            seeds,
        )
    }
}

pub fn with_tolerance(leverage_bps: u64) -> u64 {
    ((leverage_bps as u128) * (math::BPS + LEVERAGE_TOLERANCE_BPS as u128) / math::BPS)
        .min(u64::MAX as u128) as u64
}
