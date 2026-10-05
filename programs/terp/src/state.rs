use anchor_lang::prelude::*;

use crate::constants::MAX_SWAP_DISCRIMINATORS;

/// Protocol-wide settings. The admin can rotate itself, the keeper and the treasury, list perp
/// markets launches may choose from, and pause risk-increasing actions. Neither the admin nor
/// the keeper has a path to any launch's tokens, USDC, collateral or position.
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    /// The launchpad operator's key: the only one that may convert tax and deploy it. It decides
    /// when; the program decides how much, at what price, and where the money goes.
    pub keeper: Pubkey,
    /// The platform's wallet: receives the keeper fee, and residual USDC of a launch whose supply
    /// reached zero.
    pub treasury: Pubkey,
    /// Share of converted tax paid to the treasury, applied to launches created from now on.
    /// A launch keeps the rate it was created with.
    pub keeper_fee_bps: u16,
    /// AMM the tax is sold through (Meteora DLMM on mainnet). Immutable.
    pub swap_program: Pubkey,
    /// Instruction discriminators of `swap_program` a conversion may call. Immutable.
    pub swap_discriminators: [[u8; 8]; MAX_SWAP_DISCRIMINATORS],
    pub swap_discriminator_count: u8,
    /// Blocks launch creation, tax conversion and deployment. Never blocks deleveraging,
    /// redemptions or claim payouts.
    pub paused: bool,
    pub bump: u8,
}

/// A Phoenix perp market a launch can pick as its leveraged asset. Listed by the admin, never
/// edited afterwards: a launch copies these values at creation and keeps them for good.
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub asset_id: u32,
    pub orderbook: Pubkey,
    pub spline: Pubkey,
    /// Quote lots (USDC atoms) per base lot, per price tick.
    pub tick_size: u64,
    /// One base lot is `10^-base_lot_decimals` of the asset. Display only.
    pub base_lot_decimals: u8,
    /// ASCII ticker, zero-padded. Display only.
    pub symbol: [u8; 16],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Direction {
    Long,
    Short,
}

/// One launch: the tax vault of one token. It is the mint's only withdraw-withheld authority,
/// the owner of every vault asset, and the authority of the launch's own Phoenix trader account,
/// which is what isolates launches from each other.
#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub mint: Pubkey,
    pub creator: Pubkey,
    /// Liquidity pool the tax is sold into. Set once by the creator.
    pub pool: Pubkey,
    pub vault_usdc: Pubkey,
    pub tax_account: Pubkey,
    /// USDC account of the tax authority: swaps pay out here and the program forwards on.
    pub tax_usdc: Pubkey,
    /// Zero until `register_trader`.
    pub trader_account: Pubkey,
    pub canonical_account: Pubkey,

    // The leveraged asset, copied from the chosen market
    pub orderbook: Pubkey,
    pub spline: Pubkey,
    pub asset_id: u32,
    pub tick_size: u64,
    pub base_lot_decimals: u8,
    pub symbol: [u8; 16],
    pub direction: Direction,

    pub decimals: u8,
    pub bump: u8,
    pub tax_bump: u8,

    // Immutable policy
    /// The mint's transfer tax, 1% or 3%, as verified on the mint at creation.
    pub transfer_fee_bps: u16,
    pub target_leverage_bps: u32,
    /// Under this a deployment buys exposure back up to target.
    pub min_leverage_bps: u32,
    pub max_leverage_bps: u32,
    /// What a deleverage above the maximum reduces leverage to.
    pub deleverage_to_bps: u32,
    /// Share of converted tax the platform takes for running the keeper.
    pub keeper_fee_bps: u16,
    pub redemption_fee_bps: u16,
    pub exit_cost_bps: u16,
    pub order_slippage_bps: u16,
    pub max_price_drop_bps: u16,
    pub max_mark_staleness_slots: u64,
    pub min_convert_tokens: u64,
    pub max_convert_tokens: u64,
    pub convert_cooldown_slots: u64,
    pub min_deposit_usdc: u64,
    pub min_redeem_tokens: u64,

    // Disclosed at creation, verifiable against on-chain balances
    pub initial_supply: u64,
    pub creator_allocation: u64,
    pub pool_allocation: u64,

    // Conversion price reference: seeded by the creator, then a running average of conversions
    pub ema_price: u128,
    pub last_convert_slot: u64,

    /// USDC owed to redeemers whose Phoenix withdrawal was queued. Senior to equity.
    pub pending_claims: u64,

    // Cumulative accounting, actual amounts only
    pub tokens_collected: u64,
    pub tokens_converted: u64,
    /// What reached the vault: pool proceeds less the keeper fee.
    pub usdc_converted: u64,
    pub keeper_fees_paid: u64,
    /// Slot of the last deployment, or of the transfer hook's last look at the position.
    pub last_rebalance_slot: u64,
    pub usdc_deposited: u64,
    pub usdc_withdrawn: u64,
    pub tokens_redeemed: u64,
    pub usdc_redeemed: u64,
    pub redemption_fees_retained: u64,
    pub exit_costs_retained: u64,
    pub created_slot: u64,
}

impl Launch {
    pub fn is_trader_registered(&self) -> bool {
        self.trader_account != Pubkey::default()
    }
}

/// USDC owed to a redeemer whose tokens are already burned. Created only when Phoenix queued the
/// withdrawal that would have paid them; the amount is fixed and paid as soon as USDC arrives.
#[account]
#[derive(InitSpace)]
pub struct Claim {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}
