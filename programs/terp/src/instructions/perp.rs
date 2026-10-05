//! Collateral and position management. Sizes and prices come from the launch's policy and from
//! Phoenix's mark, never from the caller.
use anchor_lang::prelude::*;

use super::venue::*;
use crate::{
    constants::*,
    error::VaultError,
    events::{CanonicalUnwrapped, ClaimsFunded, Deleveraged, Deployed},
    math,
    phoenix::Fill,
    state::{Direction, Launch, ProtocolConfig},
};

/// `remaining_accounts` is the exchange's dynamic trader-index tail, validated against the
/// Phoenix global configuration.
#[derive(Accounts)]
pub struct Deploy<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper @ VaultError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    pub phoenix: PhoenixAccounts<'info>,
    pub ember: EmberAccounts<'info>,
}

/// Puts the vault's idle USDC to work. Keeper only; it decides when, the program decides what.
///
/// The aim is a position that stays open and stays close to target leverage (5x):
///
/// 1. Everything idle above what is owed to claims is deposited as Phoenix collateral, once it
///    reaches the minimum. On an open position this is added margin: leverage falls and the
///    liquidation price moves further away. After a fall in the asset, leverage is above target
///    and this is all that happens: tax pulls it back down.
/// 2. If leverage is then under the launch minimum (4.75x), or there is no position, exposure is
///    added with an IOC order until leverage is back at target. That opens the first position,
///    tops it up as collateral and gains arrive, and reopens it after it was closed or
///    liquidated. A vault with collateral never stays flat, and never goes above target here.
///
/// The decision depends on leverage only, not on whether the position is in profit.
pub fn deploy<'info>(ctx: Context<'info, Deploy<'info>>) -> Result<()> {
    require!(!ctx.accounts.config.paused, VaultError::Paused);
    let accounts = &ctx.accounts;
    let launch = &accounts.launch;
    let venue = Venue::load(
        launch,
        &accounts.phoenix,
        &accounts.ember,
        ctx.remaining_accounts,
    )?;
    let mint_key = launch.mint;
    let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[launch.bump]];

    let free = venue.idle_usdc()?.saturating_sub(launch.pending_claims);
    let deposit = if free >= launch.min_deposit_usdc {
        free
    } else {
        0
    };
    if deposit > 0 {
        venue.deposit(deposit, seeds)?;
    }

    let before = venue.view()?;
    // an account Phoenix is about to liquidate is not topped up: the deposit reverts with this
    require!(!before.is_liquidatable(), VaultError::AccountAtRisk);
    let leverage = before.leverage_bps();

    let mut lots = 0;
    if before.notional == 0 || leverage < launch.min_leverage_bps as u64 {
        let lot_value = before
            .mark_price_ticks
            .checked_mul(launch.tick_size)
            .ok_or(VaultError::MathOverflow)?;
        require!(lot_value > 0, VaultError::InvalidPhoenixReturnData);
        // aim 2% under target, leaving room for the taker fee and the order's slippage
        let aim =
            math::bps_of_u32(before.equity().max(0) as u64, launch.target_leverage_bps)? / 100 * 98;
        lots = aim.saturating_sub(before.notional) / lot_value;
    }
    require!(deposit > 0 || lots > 0, VaultError::NothingToDeploy);

    let mut fill = Fill::default();
    let mut after = before;
    if lots > 0 {
        venue.require_fresh_mark()?;
        fill = venue.order(true, lots, before.mark_price_ticks, seeds)?;
        after = venue.view()?;
        require!(
            if launch.direction == Direction::Long {
                after.base_lots >= 0
            } else {
                after.base_lots <= 0
            },
            VaultError::WrongPositionSide
        );
        require!(!after.is_liquidatable(), VaultError::AccountAtRisk);
        require!(
            after.leverage_bps() <= with_tolerance(launch.target_leverage_bps as u64),
            VaultError::LeverageTooHigh
        );
    }

    let event = Deployed {
        launch: launch.key(),
        deposited: deposit,
        leverage_bps_before: leverage,
        unrealized_pnl: before.unrealized_pnl,
        increased: lots > 0,
        requested_base_lots: lots,
        filled_base_lots: fill.base_lots,
        filled_quote_lots: fill.quote_lots,
        base_lots_after: after.base_lots,
        notional_after: after.notional,
        equity_after: after.equity(),
        leverage_bps_after: after.leverage_bps(),
    };
    let launch = &mut ctx.accounts.launch;
    launch.usdc_deposited = launch
        .usdc_deposited
        .checked_add(deposit)
        .ok_or(VaultError::MathOverflow)?;
    emit!(event);
    Ok(())
}

#[derive(Accounts)]
pub struct VenueOp<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    pub phoenix: PhoenixAccounts<'info>,
    pub ember: EmberAccounts<'info>,
}

/// When leverage is above the launch maximum (6x) or the account is liquidatable, anyone may
/// close the part of the position that brings leverage down to the launch's deleverage level
/// (5.5x). The size is computed here; the caller cannot close more, and nothing is withdrawn.
/// This is what keeps the position open through a fall, and it does not depend on the keeper.
pub fn deleverage<'info>(ctx: Context<'info, VenueOp<'info>>) -> Result<()> {
    let accounts = &ctx.accounts;
    let launch = &accounts.launch;
    let venue = Venue::load(
        launch,
        &accounts.phoenix,
        &accounts.ember,
        ctx.remaining_accounts,
    )?;
    let mint_key = launch.mint;
    let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[launch.bump]];

    let before = venue.view()?;
    let leverage = before.leverage_bps();
    require!(
        before.notional > 0
            && (before.is_liquidatable() || leverage > launch.max_leverage_bps as u64),
        VaultError::NotDeleveragable
    );
    venue.require_fresh_mark()?;

    // closing a fraction f at mark leaves leverage L(1 - f); an account with no equity closes all
    let base = before.base_lots.unsigned_abs();
    // a liquidatable account can already be under the deleverage level; it is cut all the same
    let target = (launch.deleverage_to_bps as u64).min(leverage);
    let lots = if leverage == u64::MAX {
        base
    } else {
        (((base as u128) * ((leverage - target) as u128)).div_ceil(leverage as u128) as u64).max(1)
    };
    let fill = venue.order(false, lots, before.mark_price_ticks, seeds)?;
    let after = venue.view()?;
    require!(
        after.notional < before.notional,
        VaultError::ReductionIncomplete
    );

    emit!(Deleveraged {
        launch: launch.key(),
        caller: accounts.caller.key(),
        requested_base_lots: lots,
        filled_base_lots: fill.base_lots,
        filled_quote_lots: fill.quote_lots,
        leverage_bps_before: leverage,
        leverage_bps_after: after.leverage_bps(),
    });
    Ok(())
}

/// Redeemers whose withdrawal Phoenix queued hold a fixed USDC claim. If the queued withdrawal
/// was dropped or fell short, anyone may ask Phoenix again for exactly the shortfall. The
/// redeemer's share of the position was already closed when they redeemed, so this only moves
/// collateral, and only while leverage stays under the launch maximum.
pub fn fund_claims<'info>(ctx: Context<'info, VenueOp<'info>>) -> Result<()> {
    let accounts = &ctx.accounts;
    let launch = &accounts.launch;
    let venue = Venue::load(
        launch,
        &accounts.phoenix,
        &accounts.ember,
        ctx.remaining_accounts,
    )?;
    let mint_key = launch.mint;
    let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[launch.bump]];

    venue.unwrap(seeds)?;
    let shortfall = launch.pending_claims.saturating_sub(venue.idle_usdc()?);
    require!(shortfall > 0, VaultError::NothingToPay);
    let arrived = venue.withdraw(shortfall, seeds)?;

    let after = venue.view()?;
    require!(
        after.notional == 0 || after.leverage_bps() <= launch.max_leverage_bps as u64,
        VaultError::LeverageTooHigh
    );

    let launch = &mut ctx.accounts.launch;
    launch.usdc_withdrawn = launch
        .usdc_withdrawn
        .checked_add(arrived)
        .ok_or(VaultError::MathOverflow)?;
    emit!(ClaimsFunded {
        launch: launch.key(),
        requested: shortfall,
        arrived,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UnwrapCanonical<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    pub ember: EmberAccounts<'info>,
}

/// Turns canonical tokens in the vault (a queued Phoenix withdrawal that has since been paid)
/// back into USDC. Permissionless: source and destination are fixed vault accounts.
pub fn unwrap_canonical(ctx: Context<UnwrapCanonical>) -> Result<()> {
    let accounts = &ctx.accounts;
    let (launch, ember) = (&accounts.launch, &accounts.ember);
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
    require!(
        token_amount(&ember.canonical_account)? > 0,
        VaultError::NothingToPay
    );

    let launch_info = launch.to_account_info();
    let vault_usdc = ember.vault_usdc.to_account_info();
    let mint_key = launch.mint;
    let before = ember.vault_usdc.amount;
    crate::phoenix::Ember {
        ember_program: &ember.ember_program,
        trader: &launch_info,
        ember_state: &ember.ember_state,
        usdc_mint: &ember.usdc_mint,
        canonical_mint: &ember.canonical_mint,
        trader_usdc: &vault_usdc,
        trader_canonical: &ember.canonical_account,
        ember_vault: &ember.ember_vault,
        token_program: &ember.token_program,
    }
    .withdraw_all(&[LAUNCH_SEED, mint_key.as_ref(), &[launch.bump]])?;

    let arrived = token_amount(&vault_usdc)?.saturating_sub(before);
    let launch = &mut ctx.accounts.launch;
    launch.usdc_withdrawn = launch
        .usdc_withdrawn
        .checked_add(arrived)
        .ok_or(VaultError::MathOverflow)?;
    emit!(CanonicalUnwrapped {
        launch: launch.key(),
        usdc: arrived,
    });
    Ok(())
}
