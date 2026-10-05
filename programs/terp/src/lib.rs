//! Launchpad for fixed-supply Token-2022 tokens whose 3% transfer tax is converted to USDC and
//! used as collateral for a leveraged Phoenix perp position, one isolated vault per token.
//! Holders redeem by burning tokens for their proportional share of net vault equity.
//!
//! See `docs/ARCHITECTURE.md` for the authority model and `docs/ECONOMICS.md` for the accounting.
#![allow(ambiguous_glob_reexports)]

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod phoenix;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("8mGW6pAB1H2mpyx8muVQTAEVf9dLLGxu5H3h4Ch2GtAh");

#[program]
pub mod terp {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, args: InitConfigArgs) -> Result<()> {
        instructions::admin::init_config(ctx, args)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::admin::update_config(ctx, args)
    }

    pub fn add_market(ctx: Context<AddMarket>, args: AddMarketArgs) -> Result<()> {
        instructions::admin::add_market(ctx, args)
    }

    pub fn create_launch(ctx: Context<CreateLaunch>, args: CreateLaunchArgs) -> Result<()> {
        instructions::launch::create_launch(ctx, args)
    }

    pub fn set_pool(ctx: Context<SetPool>) -> Result<()> {
        instructions::launch::set_pool(ctx)
    }

    pub fn register_trader(ctx: Context<RegisterTrader>) -> Result<()> {
        instructions::launch::register_trader(ctx)
    }

    pub fn collect_tax<'info>(ctx: Context<'info, CollectTax<'info>>) -> Result<()> {
        instructions::tax::collect_tax(ctx)
    }

    pub fn convert_tax<'info>(
        ctx: Context<'info, ConvertTax<'info>>,
        tokens_in: u64,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        instructions::tax::convert_tax(ctx, tokens_in, swap_data)
    }

    pub fn deploy<'info>(ctx: Context<'info, Deploy<'info>>) -> Result<()> {
        instructions::perp::deploy(ctx)
    }

    pub fn deleverage<'info>(ctx: Context<'info, VenueOp<'info>>) -> Result<()> {
        instructions::perp::deleverage(ctx)
    }

    pub fn rebalance<'info>(ctx: Context<'info, Rebalance<'info>>) -> Result<()> {
        instructions::perp::rebalance(ctx)
    }

    pub fn fund_claims<'info>(ctx: Context<'info, VenueOp<'info>>) -> Result<()> {
        instructions::perp::fund_claims(ctx)
    }

    pub fn unwrap_canonical(ctx: Context<UnwrapCanonical>) -> Result<()> {
        instructions::perp::unwrap_canonical(ctx)
    }

    pub fn redeem<'info>(
        ctx: Context<'info, Redeem<'info>>,
        amount: u64,
        min_payout: u64,
    ) -> Result<()> {
        instructions::redeem::redeem(ctx, amount, min_payout)
    }

    pub fn pay_claim(ctx: Context<PayClaim>) -> Result<()> {
        instructions::redeem::pay_claim(ctx)
    }

    pub fn sweep_residual(ctx: Context<SweepResidual>) -> Result<()> {
        instructions::redeem::sweep_residual(ctx)
    }
}
