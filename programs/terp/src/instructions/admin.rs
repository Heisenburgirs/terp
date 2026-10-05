use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::VaultError,
    phoenix,
    state::{Market, ProtocolConfig},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitConfigArgs {
    pub keeper: Pubkey,
    pub treasury: Pubkey,
    pub keeper_fee_bps: u16,
    pub swap_program: Pubkey,
    pub swap_discriminators: Vec<[u8; 8]>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

pub fn init_config(ctx: Context<InitConfig>, args: InitConfigArgs) -> Result<()> {
    require!(
        !args.swap_discriminators.is_empty()
            && args.swap_discriminators.len() <= MAX_SWAP_DISCRIMINATORS
            && args.keeper_fee_bps <= MAX_KEEPER_FEE_BPS,
        VaultError::InvalidParameter
    );
    let mut swap_discriminators = [[0u8; 8]; MAX_SWAP_DISCRIMINATORS];
    for (slot, value) in swap_discriminators
        .iter_mut()
        .zip(&args.swap_discriminators)
    {
        *slot = *value;
    }

    ctx.accounts.config.set_inner(ProtocolConfig {
        admin: ctx.accounts.admin.key(),
        keeper: args.keeper,
        treasury: args.treasury,
        keeper_fee_bps: args.keeper_fee_bps,
        swap_program: args.swap_program,
        swap_discriminators,
        swap_discriminator_count: args.swap_discriminators.len() as u8,
        paused: false,
        bump: ctx.bumps.config,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateConfigArgs {
    pub admin: Option<Pubkey>,
    pub keeper: Option<Pubkey>,
    pub treasury: Option<Pubkey>,
    /// For launches created afterwards; existing launches keep their rate.
    pub keeper_fee_bps: Option<u16>,
    pub paused: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
}

/// Rotate the admin, the keeper and the treasury, and pause risk-increasing actions.
pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    if let Some(admin) = args.admin {
        config.admin = admin;
    }
    if let Some(keeper) = args.keeper {
        config.keeper = keeper;
    }
    if let Some(treasury) = args.treasury {
        config.treasury = treasury;
    }
    if let Some(keeper_fee_bps) = args.keeper_fee_bps {
        require!(
            keeper_fee_bps <= MAX_KEEPER_FEE_BPS,
            VaultError::InvalidParameter
        );
        config.keeper_fee_bps = keeper_fee_bps;
    }
    if let Some(paused) = args.paused {
        config.paused = paused;
    }
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AddMarketArgs {
    pub asset_id: u32,
    pub tick_size: u64,
    pub base_lot_decimals: u8,
    pub symbol: [u8; 16],
}

#[derive(Accounts)]
#[instruction(args: AddMarketArgs)]
pub struct AddMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &args.asset_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: must be an account of the Phoenix perps program
    #[account(owner = phoenix::PHOENIX_PROGRAM_ID @ VaultError::InvalidPhoenixAccount)]
    pub orderbook: UncheckedAccount<'info>,
    /// CHECK: must be the spline PDA of that orderbook
    #[account(owner = phoenix::PHOENIX_PROGRAM_ID @ VaultError::InvalidPhoenixAccount)]
    pub spline: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Lists a Phoenix perp market as a leveraged asset new launches may choose. A listing cannot be
/// changed or removed, and it affects only launches that pick it; existing launches keep the
/// market they were created with.
pub fn add_market(ctx: Context<AddMarket>, args: AddMarketArgs) -> Result<()> {
    require!(args.tick_size > 0, VaultError::InvalidParameter);
    let (spline, _) = Pubkey::find_program_address(
        &[b"spline", ctx.accounts.orderbook.key().as_ref()],
        &phoenix::PHOENIX_PROGRAM_ID,
    );
    require_keys_eq!(
        ctx.accounts.spline.key(),
        spline,
        VaultError::InvalidPhoenixAccount
    );

    ctx.accounts.market.set_inner(Market {
        asset_id: args.asset_id,
        orderbook: ctx.accounts.orderbook.key(),
        spline,
        tick_size: args.tick_size,
        base_lot_decimals: args.base_lot_decimals,
        symbol: args.symbol,
        bump: ctx.bumps.market,
    });
    Ok(())
}
