//! Events are the launch's history: the frontend rebuilds tax, conversion, position and
//! redemption history from them. Every amount is what actually moved on-chain.
use anchor_lang::prelude::*;

#[event]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub initial_supply: u64,
    pub creator_allocation: u64,
    pub pool_allocation: u64,
}

#[event]
pub struct PoolSet {
    pub launch: Pubkey,
    pub pool: Pubkey,
}

#[event]
pub struct TraderRegistered {
    pub launch: Pubkey,
    pub trader_account: Pubkey,
}

#[event]
pub struct TaxCollected {
    pub launch: Pubkey,
    pub tokens: u64,
}

#[event]
pub struct TaxConverted {
    pub launch: Pubkey,
    pub tokens_in: u64,
    /// What the pool paid.
    pub usdc_out: u64,
    /// The platform's platform fee, paid to the treasury; the rest went to the vault.
    pub platform_fee: u64,
    /// USDC atoms per token atom, scaled by 1e12.
    pub price: u128,
}

#[event]
pub struct Deployed {
    pub launch: Pubkey,
    /// USDC deposited as Phoenix collateral.
    pub deposited: u64,
    /// Leverage once the deposit was in, before any order.
    pub leverage_bps_before: u64,
    /// The position's unrealized PnL when the call ran.
    pub unrealized_pnl: i64,
    /// True when exposure was added: there was no position, or leverage was under the minimum.
    pub increased: bool,
    pub requested_base_lots: u64,
    pub filled_base_lots: u64,
    pub filled_quote_lots: u64,
    pub base_lots_after: i64,
    pub notional_after: u64,
    pub equity_after: i64,
    pub leverage_bps_after: u64,
}

#[event]
pub struct Deleveraged {
    pub launch: Pubkey,
    pub caller: Pubkey,
    pub requested_base_lots: u64,
    pub filled_base_lots: u64,
    pub filled_quote_lots: u64,
    pub leverage_bps_before: u64,
    pub leverage_bps_after: u64,
}

#[event]
pub struct CanonicalUnwrapped {
    pub launch: Pubkey,
    pub usdc: u64,
}

#[event]
pub struct Redeemed {
    pub launch: Pubkey,
    pub owner: Pubkey,
    /// `q`
    pub tokens_burned: u64,
    /// `S` before the burn
    pub supply_before: u64,
    /// `E` at redemption, net of claims
    pub equity: u64,
    pub notional: u64,
    pub gross: u64,
    pub redemption_fee: u64,
    pub exit_cost: u64,
    pub payout: u64,
    /// Paid in this transaction.
    pub paid: u64,
    /// Recorded as a claim because Phoenix queued the withdrawal.
    pub owed: u64,
    pub base_lots_closed: u64,
    pub usdc_withdrawn: u64,
}

#[event]
pub struct ClaimsFunded {
    pub launch: Pubkey,
    pub requested: u64,
    pub arrived: u64,
}

#[event]
pub struct ClaimPaid {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub usdc: u64,
    pub remaining: u64,
}

#[event]
pub struct ResidualSwept {
    pub launch: Pubkey,
    pub usdc: u64,
}
