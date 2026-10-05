use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const TAX_SEED: &[u8] = b"tax";
pub const CLAIM_SEED: &[u8] = b"claim";
pub const MARKET_SEED: &[u8] = b"market";
/// Seed of the account list Token-2022 reads for a mint's transfer hook (fixed by its interface).
pub const HOOK_SEED: &[u8] = b"extra-account-metas";
/// Instruction discriminator Token-2022 calls a transfer hook with: the first 8 bytes of
/// sha256("spl-transfer-hook-interface:execute").
pub const EXECUTE_DISCRIMINATOR: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// The hook acts only when called at most this deep: 2 from a plain transfer, 3 from a pool
/// swap sent directly. Acting adds two more levels and the runtime allows five.
pub const HOOK_MAX_STACK_HEIGHT: usize = 3;
/// The hook acts only in a transaction that asked for at least this compute-unit limit.
pub const HOOK_MIN_COMPUTE_UNITS: u32 = 1_000_000;
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
pub const COMPUTE_BUDGET_PROGRAM_ID: Pubkey =
    pubkey!("ComputeBudget111111111111111111111111111111");
/// Token-2022 runs out of memory resolving more than 15 hook accounts; a list longer than this
/// is written empty instead, which switches the hook off rather than freezing transfers.
pub const HOOK_MAX_ACCOUNTS: usize = 14;
/// The hook looks at the position at most once per this many slots (~10s).
pub const HOOK_MIN_INTERVAL_SLOTS: u64 = 25;

/// Mainnet USDC, the only quote and collateral asset of the MVP.
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const USDC_DECIMALS: u8 = 6;

/// Transfer-tax tiers a launch may choose from. The tier is fixed on the mint for good.
pub const TRANSFER_FEE_TIERS: [u16; 2] = [100, 300];
/// Separate fee on redemptions, retained in the vault for the remaining holders.
pub const REDEMPTION_FEE_BPS: u16 = 300;

// Policy, copied into each launch at creation and immutable afterwards. Whoever sends the transaction decides when
// tax is converted and deployed; every size and price comes from these numbers and from chain
// state, never from the caller.

/// The leverage the vault aims to keep, and the ceiling after any buy: 5x.
pub const TARGET_LEVERAGE_BPS: u32 = 50_000;
/// Under this (4.75x) a deployment buys exposure back up to target. Between this and target
/// nothing is traded, so small drifts do not cost taker fees.
pub const MIN_LEVERAGE_BPS: u32 = 47_500;
/// Above this (6x) anyone may reduce the position.
pub const MAX_LEVERAGE_BPS: u32 = 60_000;
/// What a deleverage reduces to: 5.5x. Short of target, so less of the loss is realised; tax
/// margin brings it the rest of the way.
pub const DELEVERAGE_TO_BPS: u32 = 55_000;
/// Highest share of converted tax the platform may take as its platform fee.
pub const MAX_PLATFORM_FEE_BPS: u16 = 2_000;
/// Relative slack on leverage post-checks, covering taker fees and rounding.
pub const LEVERAGE_TOLERANCE_BPS: u64 = 100;
/// Charged on the redeemer's slice of open notional: Phoenix taker fee (3.5 bps) plus slippage.
pub const EXIT_COST_BPS: u16 = 5;
/// Distance of every order's limit price from Phoenix's mark, on the taker's adverse side.
pub const ORDER_SLIPPAGE_BPS: u16 = 50;
/// Trades and redemptions against an open position refuse a mark older than this (~60s).
pub const MAX_MARK_STALENESS_SLOTS: u64 = 150;

pub const MAX_PRICE_DROP_BPS_LIMIT: u16 = 2_000;
pub const MAX_SWAP_DISCRIMINATORS: usize = 4;
pub const MAX_SWAP_DATA_LEN: usize = 256;
/// Where the allowlisted swap instruction (Meteora DLMM `swap` / `swap2`) takes the pool, the
/// account it sells from and the account it pays into.
pub const SWAP_POOL_INDEX: usize = 0;
pub const SWAP_TOKEN_IN_INDEX: usize = 4;
pub const SWAP_TOKEN_OUT_INDEX: usize = 5;
