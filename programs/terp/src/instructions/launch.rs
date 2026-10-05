use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::{
        spl_token_2022::{
            extension::{
                metadata_pointer::MetadataPointer, transfer_fee::TransferFeeConfig,
                BaseStateWithExtensions, ExtensionType, StateWithExtensions,
            },
            state::Mint as MintState,
        },
        Token2022,
    },
    token_interface::{spl_token_metadata_interface::state::TokenMetadata, Mint, TokenAccount},
};

use crate::{
    constants::*,
    error::VaultError,
    events::{LaunchCreated, PoolSet, TraderRegistered},
    phoenix::{self, Exchange, Phoenix, TraderHeader},
    state::{Direction, Launch, Market, ProtocolConfig},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateLaunchArgs {
    /// Must equal the mint's supply; nothing can be minted afterwards.
    pub total_supply: u64,
    /// Disclosed split of the supply. Informational, checked to add up; actual balances are
    /// public on-chain.
    pub creator_allocation: u64,
    pub pool_allocation: u64,
    /// The pool's starting price, USDC atoms per token atom scaled by 1e12. It seeds the
    /// reference price that tax conversions are checked against.
    pub initial_price: u128,
    /// Tax batches below this are not converted.
    pub min_convert_tokens: u64,
    /// Largest tax batch sold in one conversion.
    pub max_convert_tokens: u64,
    pub convert_cooldown_slots: u64,
    /// How far below the reference price one conversion may execute, per cooldown elapsed.
    pub max_price_drop_bps: u16,
    /// USDC batches below this are not deposited as collateral.
    pub min_deposit_usdc: u64,
    pub min_redeem_tokens: u64,
}

#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    /// The Phoenix perp market this launch's tax will be levered into.
    #[account(seeds = [MARKET_SEED, &market.asset_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = creator,
        space = 8 + Launch::INIT_SPACE,
        seeds = [LAUNCH_SEED, mint.key().as_ref()],
        bump
    )]
    pub launch: Box<Account<'info, Launch>>,
    /// CHECK: PDA that owns the tax token account and signs only tax swaps.
    #[account(seeds = [TAX_SEED, launch.key().as_ref()], bump)]
    pub tax_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = tax_authority,
        associated_token::token_program = token_2022_program
    )]
    pub tax_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = usdc_mint,
        associated_token::authority = launch,
        associated_token::token_program = token_program
    )]
    pub vault_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = usdc_mint,
        associated_token::authority = tax_authority,
        associated_token::token_program = token_program
    )]
    pub tax_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Checks that nobody can change the token's economics after launch: fixed supply, no mint or
/// freeze authority, an immutable 1% or 3% transfer fee whose withheld tokens only the launch vault can
/// withdraw, and no extension that could move or tax tokens in other ways.
fn validate_mint(mint_info: &AccountInfo, launch: &Pubkey, total_supply: u64) -> Result<u16> {
    let data = mint_info.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(VaultError::MintNotToken2022))?;

    require!(
        state.base.mint_authority.is_none(),
        VaultError::MintAuthorityPresent
    );
    require!(
        state.base.freeze_authority.is_none(),
        VaultError::FreezeAuthorityPresent
    );
    require!(
        total_supply > 0 && state.base.supply == total_supply,
        VaultError::SupplyMismatch
    );

    for extension in state.get_extension_types()? {
        require!(
            matches!(
                extension,
                ExtensionType::TransferFeeConfig
                    | ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
            ),
            VaultError::UnsupportedMintExtension
        );
    }

    let fee = state
        .get_extension::<TransferFeeConfig>()
        .map_err(|_| error!(VaultError::InvalidTransferFee))?;
    require!(
        Option::<Pubkey>::from(fee.transfer_fee_config_authority).is_none(),
        VaultError::TransferFeeAuthorityPresent
    );
    require!(
        Option::<Pubkey>::from(fee.withdraw_withheld_authority) == Some(*launch),
        VaultError::InvalidWithheldAuthority
    );
    let transfer_fee_bps = u16::from(fee.newer_transfer_fee.transfer_fee_basis_points);
    require!(
        TRANSFER_FEE_TIERS.contains(&transfer_fee_bps),
        VaultError::InvalidTransferFee
    );
    for schedule in [&fee.older_transfer_fee, &fee.newer_transfer_fee] {
        require!(
            u16::from(schedule.transfer_fee_basis_points) == transfer_fee_bps
                && u64::from(schedule.maximum_fee) == u64::MAX,
            VaultError::InvalidTransferFee
        );
    }

    if let Ok(pointer) = state.get_extension::<MetadataPointer>() {
        require!(
            Option::<Pubkey>::from(pointer.authority).is_none()
                && Option::<Pubkey>::from(pointer.metadata_address) == Some(mint_info.key()),
            VaultError::MutableMetadata
        );
    }
    if let Ok(metadata) = state.get_variable_len_extension::<TokenMetadata>() {
        require!(
            Option::<Pubkey>::from(metadata.update_authority).is_none(),
            VaultError::MutableMetadata
        );
    }
    Ok(transfer_fee_bps)
}

pub fn create_launch(ctx: Context<CreateLaunch>, args: CreateLaunchArgs) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, VaultError::Paused);

    let launch_key = ctx.accounts.launch.key();
    let transfer_fee_bps = validate_mint(
        &ctx.accounts.mint.to_account_info(),
        &launch_key,
        args.total_supply,
    )?;
    let market = &ctx.accounts.market;

    require!(
        args.creator_allocation
            .checked_add(args.pool_allocation)
            .ok_or(VaultError::MathOverflow)?
            == args.total_supply,
        VaultError::AllocationMismatch
    );
    require!(
        args.initial_price > 0
            && args.min_convert_tokens > 0
            && args.max_convert_tokens >= args.min_convert_tokens
            && args.convert_cooldown_slots > 0
            && args.max_price_drop_bps > 0
            && args.max_price_drop_bps <= MAX_PRICE_DROP_BPS_LIMIT
            && args.min_deposit_usdc > 0
            && args.min_redeem_tokens > 0,
        VaultError::InvalidParameter
    );

    let slot = Clock::get()?.slot;
    ctx.accounts.launch.set_inner(Launch {
        mint: ctx.accounts.mint.key(),
        creator: ctx.accounts.creator.key(),
        pool: Pubkey::default(),
        vault_usdc: ctx.accounts.vault_usdc.key(),
        tax_account: ctx.accounts.tax_account.key(),
        tax_usdc: ctx.accounts.tax_usdc.key(),
        trader_account: Pubkey::default(),
        canonical_account: Pubkey::default(),
        orderbook: market.orderbook,
        spline: market.spline,
        asset_id: market.asset_id,
        tick_size: market.tick_size,
        base_lot_decimals: market.base_lot_decimals,
        symbol: market.symbol,
        direction: Direction::Long,
        transfer_fee_bps,
        decimals: ctx.accounts.mint.decimals,
        bump: ctx.bumps.launch,
        tax_bump: ctx.bumps.tax_authority,
        target_leverage_bps: TARGET_LEVERAGE_BPS,
        min_leverage_bps: MIN_LEVERAGE_BPS,
        max_leverage_bps: MAX_LEVERAGE_BPS,
        deleverage_to_bps: DELEVERAGE_TO_BPS,
        keeper_fee_bps: config.keeper_fee_bps,
        redemption_fee_bps: REDEMPTION_FEE_BPS,
        exit_cost_bps: EXIT_COST_BPS,
        order_slippage_bps: ORDER_SLIPPAGE_BPS,
        max_price_drop_bps: args.max_price_drop_bps,
        max_mark_staleness_slots: MAX_MARK_STALENESS_SLOTS,
        min_convert_tokens: args.min_convert_tokens,
        max_convert_tokens: args.max_convert_tokens,
        convert_cooldown_slots: args.convert_cooldown_slots,
        min_deposit_usdc: args.min_deposit_usdc,
        min_redeem_tokens: args.min_redeem_tokens,
        initial_supply: args.total_supply,
        creator_allocation: args.creator_allocation,
        pool_allocation: args.pool_allocation,
        ema_price: args.initial_price,
        last_convert_slot: slot,
        pending_claims: 0,
        tokens_collected: 0,
        tokens_converted: 0,
        usdc_converted: 0,
        keeper_fees_paid: 0,
        usdc_deposited: 0,
        usdc_withdrawn: 0,
        tokens_redeemed: 0,
        usdc_redeemed: 0,
        redemption_fees_retained: 0,
        exit_costs_retained: 0,
        created_slot: slot,
    });

    emit!(LaunchCreated {
        launch: launch_key,
        mint: ctx.accounts.mint.key(),
        creator: ctx.accounts.creator.key(),
        initial_supply: args.total_supply,
        creator_allocation: args.creator_allocation,
        pool_allocation: args.pool_allocation,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPool<'info> {
    pub creator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump, has_one = creator @ VaultError::Unauthorized)]
    pub launch: Box<Account<'info, Launch>>,
    /// CHECK: must be an account of the configured swap program.
    #[account(owner = config.swap_program @ VaultError::InvalidPool)]
    pub pool: UncheckedAccount<'info>,
}

/// Records the launch's liquidity pool, once. Tax conversions must route through it.
pub fn set_pool(ctx: Context<SetPool>) -> Result<()> {
    let launch = &mut ctx.accounts.launch;
    require!(launch.pool == Pubkey::default(), VaultError::PoolAlreadySet);
    launch.pool = ctx.accounts.pool.key();
    emit!(PoolSet {
        launch: launch.key(),
        pool: launch.pool,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterTrader<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    /// CHECK: address-constrained
    #[account(address = phoenix::PHOENIX_PROGRAM_ID)]
    pub phoenix_program: UncheckedAccount<'info>,
    /// CHECK: address-constrained
    #[account(address = phoenix::PHOENIX_LOG_AUTHORITY)]
    pub log_authority: UncheckedAccount<'info>,
    /// CHECK: address-constrained, parsed in the handler
    #[account(address = phoenix::PHOENIX_GLOBAL_CONFIG)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: derived from the launch in the handler
    #[account(mut)]
    pub trader_account: UncheckedAccount<'info>,
    pub canonical_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = canonical_mint,
        associated_token::authority = launch,
        associated_token::token_program = token_program
    )]
    pub canonical_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Creates the launch's own Phoenix trader account, whose authority is the launch PDA.
/// Permissionless: the outcome is fixed. Phoenix must still enable the trader's capabilities
/// through its onboarding flow before deposits and orders are accepted.
pub fn register_trader(ctx: Context<RegisterTrader>) -> Result<()> {
    let launch_key = ctx.accounts.launch.key();
    require!(
        !ctx.accounts.launch.is_trader_registered(),
        VaultError::TraderAlreadyRegistered
    );
    require_keys_eq!(
        ctx.accounts.trader_account.key(),
        phoenix::trader_address(&launch_key),
        VaultError::InvalidPhoenixAccount
    );
    let exchange = Exchange::load(&ctx.accounts.global_config)?;
    require_keys_eq!(
        ctx.accounts.canonical_mint.key(),
        exchange.canonical_mint,
        VaultError::InvalidPhoenixAccount
    );

    // anyone may have registered the PDA's trader directly on Phoenix already
    if *ctx.accounts.trader_account.owner != phoenix::PHOENIX_PROGRAM_ID {
        Phoenix {
            phoenix_program: &ctx.accounts.phoenix_program,
            log_authority: &ctx.accounts.log_authority,
            global_config: &ctx.accounts.global_config,
            trader: &ctx.accounts.launch.to_account_info(),
            trader_account: &ctx.accounts.trader_account,
            tail: &[],
        }
        .register_trader(&ctx.accounts.payer, &ctx.accounts.system_program)?;
    }
    let header = TraderHeader::load(&ctx.accounts.trader_account)?;
    require_keys_eq!(
        header.authority,
        launch_key,
        VaultError::InvalidPhoenixAccount
    );

    let launch = &mut ctx.accounts.launch;
    launch.trader_account = ctx.accounts.trader_account.key();
    launch.canonical_account = ctx.accounts.canonical_account.key();
    emit!(TraderRegistered {
        launch: launch_key,
        trader_account: launch.trader_account,
    });
    Ok(())
}
