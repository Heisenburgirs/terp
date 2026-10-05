use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::{
    token::Token,
    token_2022::{spl_token_2022::extension::transfer_fee::instruction as fee_ix, Token2022},
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};

use crate::{
    constants::*,
    error::VaultError,
    events::{TaxCollected, TaxConverted},
    math,
    state::{Launch, ProtocolConfig},
};

#[derive(Accounts)]
pub struct CollectTax<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [LAUNCH_SEED, mint.key().as_ref()], bump = launch.bump, has_one = mint, has_one = tax_account)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub tax_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Moves withheld transfer-tax tokens into the launch's tax account, from the token accounts in
/// `remaining_accounts` and from the mint (where anyone can harvest them). Permissionless: the
/// launch PDA is the only withdraw-withheld authority and the destination is fixed.
///
/// Token-2022 withholds the tax inside the recipient's token account at transfer time; it
/// cannot send it anywhere else, and a transfer hook cannot either. This sweep is how the tax
/// reaches the vault.
pub fn collect_tax<'info>(ctx: Context<'info, CollectTax<'info>>) -> Result<()> {
    let launch = &ctx.accounts.launch;
    let mint_key = ctx.accounts.mint.key();
    let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[launch.bump]];
    let token_program = ctx.accounts.token_2022_program.key();
    let before = ctx.accounts.tax_account.amount;

    let launch_info = launch.to_account_info();
    let mint_info = ctx.accounts.mint.to_account_info();
    let tax_info = ctx.accounts.tax_account.to_account_info();
    let token_info = ctx.accounts.token_2022_program.to_account_info();

    if !ctx.remaining_accounts.is_empty() {
        let sources: Vec<Pubkey> = ctx.remaining_accounts.iter().map(|a| a.key()).collect();
        let source_refs: Vec<&Pubkey> = sources.iter().collect();
        let ix = fee_ix::withdraw_withheld_tokens_from_accounts(
            &token_program,
            &mint_key,
            &tax_info.key(),
            &launch_info.key(),
            &[],
            &source_refs,
        )?;
        let mut infos = vec![
            mint_info.clone(),
            tax_info.clone(),
            launch_info.clone(),
            token_info.clone(),
        ];
        infos.extend(ctx.remaining_accounts.iter().cloned());
        invoke_signed(&ix, &infos, &[seeds])?;
    }

    let ix = fee_ix::withdraw_withheld_tokens_from_mint(
        &token_program,
        &mint_key,
        &tax_info.key(),
        &launch_info.key(),
        &[],
    )?;
    invoke_signed(
        &ix,
        &[mint_info, tax_info, launch_info, token_info],
        &[seeds],
    )?;

    ctx.accounts.tax_account.reload()?;
    let collected = ctx
        .accounts
        .tax_account
        .amount
        .checked_sub(before)
        .ok_or(VaultError::MathOverflow)?;
    require!(collected > 0, VaultError::NothingCollected);

    let launch = &mut ctx.accounts.launch;
    launch.tokens_collected = launch
        .tokens_collected
        .checked_add(collected)
        .ok_or(VaultError::MathOverflow)?;
    emit!(TaxCollected {
        launch: launch.key(),
        tokens: collected,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ConvertTax<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper @ VaultError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [LAUNCH_SEED, launch.mint.as_ref()],
        bump = launch.bump,
        has_one = tax_account,
        has_one = tax_usdc,
        has_one = vault_usdc,
    )]
    pub launch: Box<Account<'info, Launch>>,
    /// CHECK: PDA signer of the swap; owns nothing but the tax account and a pass-through.
    #[account(seeds = [TAX_SEED, launch.key().as_ref()], bump = launch.tax_bump)]
    pub tax_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub tax_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub tax_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The platform treasury's USDC account, for the keeper fee.
    #[account(mut, token::mint = usdc_mint, token::authority = config.treasury)]
    pub treasury_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: must be the configured swap program.
    #[account(executable, address = config.swap_program @ VaultError::SwapNotAllowed)]
    pub swap_program: UncheckedAccount<'info>,
}

/// Sells one batch of tax tokens for USDC through the launch's pool. Keeper only.
///
/// The keeper supplies the AMM's swap instruction (accounts in `remaining_accounts`, data in
/// `swap_data`), but the program does not rely on the keeper being honest or careful:
///
/// - the batch size is fixed by the program: the tax balance, capped at `max_convert_tokens`,
///   and only once it has reached `min_convert_tokens` and the cooldown has passed;
/// - the program signs only as the tax authority, which owns nothing but the tax tokens;
/// - the sale must realize at least the reference price less `max_price_drop_bps` per cooldown
///   period elapsed. The reference starts at the pool's launch price and follows a running
///   average of conversions;
/// - the pool's proceeds are split in this instruction: the launch's fixed keeper fee to the
///   platform treasury, everything else to the launch's vault. Neither destination is the
///   keeper's to choose.
pub fn convert_tax<'info>(
    ctx: Context<'info, ConvertTax<'info>>,
    tokens_in: u64,
    swap_data: Vec<u8>,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let launch = &ctx.accounts.launch;
    require!(!config.paused, VaultError::Paused);
    require!(
        swap_data.len() >= 8 && swap_data.len() <= MAX_SWAP_DATA_LEN,
        VaultError::SwapNotAllowed
    );
    require!(
        config.swap_discriminators[..config.swap_discriminator_count as usize]
            .iter()
            .any(|d| d[..] == swap_data[..8]),
        VaultError::SwapNotAllowed
    );
    require!(
        launch.pool != Pubkey::default()
            && ctx
                .remaining_accounts
                .iter()
                .any(|a| a.key() == launch.pool),
        VaultError::SwapPoolMissing
    );

    let slot = Clock::get()?.slot;
    let elapsed = slot.saturating_sub(launch.last_convert_slot);
    require!(
        launch.tokens_converted == 0 || elapsed >= launch.convert_cooldown_slots,
        VaultError::ConversionCooldown
    );
    let tokens_before = ctx.accounts.tax_account.amount;
    let usdc_before = ctx.accounts.tax_usdc.amount;
    require!(
        tokens_before >= launch.min_convert_tokens,
        VaultError::ConversionTooSmall
    );
    // a little under the batch is fine (tax can arrive between building and landing the
    // transaction), dust-sized sales are not
    let batch = tokens_before.min(launch.max_convert_tokens);
    require!(
        tokens_in <= batch && (tokens_in as u128) * 10 >= (batch as u128) * 9,
        VaultError::ConversionWrongSize
    );

    let tax_authority = ctx.accounts.tax_authority.key();
    let metas = ctx
        .remaining_accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: a.key(),
            is_signer: a.key() == tax_authority,
            is_writable: a.is_writable,
        })
        .collect();
    let mut infos = ctx.remaining_accounts.to_vec();
    infos.push(ctx.accounts.swap_program.to_account_info());
    let launch_key = launch.key();
    let tax_seeds: &[&[&[u8]]] = &[&[TAX_SEED, launch_key.as_ref(), &[launch.tax_bump]]];
    invoke_signed(
        &Instruction {
            program_id: config.swap_program,
            accounts: metas,
            data: swap_data,
        },
        &infos,
        tax_seeds,
    )?;

    ctx.accounts.tax_account.reload()?;
    ctx.accounts.tax_usdc.reload()?;
    let spent = tokens_before
        .checked_sub(ctx.accounts.tax_account.amount)
        .ok_or(VaultError::MathOverflow)?;
    let usdc_out = ctx
        .accounts
        .tax_usdc
        .amount
        .checked_sub(usdc_before)
        .ok_or(VaultError::SlippageExceeded)?;
    require!(
        spent <= tokens_in && (spent as u128) * 10 >= (batch as u128) * 9,
        VaultError::ConversionWrongSize
    );
    require!(usdc_out > 0, VaultError::SlippageExceeded);

    let price = math::conversion_price(usdc_out, spent)?;
    let floor = math::conversion_price_floor(
        launch.ema_price,
        launch.max_price_drop_bps,
        elapsed,
        launch.convert_cooldown_slots,
    );
    require!(price >= floor, VaultError::ConversionPriceTooLow);

    let keeper_fee = math::bps_of(usdc_out, launch.keeper_fee_bps);
    let to_vault = ctx.accounts.tax_usdc.amount - keeper_fee;
    let decimals = ctx.accounts.usdc_mint.decimals;
    for (to, amount) in [
        (ctx.accounts.treasury_usdc.to_account_info(), keeper_fee),
        (ctx.accounts.vault_usdc.to_account_info(), to_vault),
    ] {
        if amount == 0 {
            continue;
        }
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.tax_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to,
                    authority: ctx.accounts.tax_authority.to_account_info(),
                },
                tax_seeds,
            ),
            amount,
            decimals,
        )?;
    }

    let launch = &mut ctx.accounts.launch;
    launch.ema_price = math::ema_update(launch.ema_price, price);
    launch.last_convert_slot = slot;
    launch.tokens_converted = launch
        .tokens_converted
        .checked_add(spent)
        .ok_or(VaultError::MathOverflow)?;
    launch.usdc_converted = launch
        .usdc_converted
        .checked_add(to_vault)
        .ok_or(VaultError::MathOverflow)?;
    launch.keeper_fees_paid = launch
        .keeper_fees_paid
        .checked_add(keeper_fee)
        .ok_or(VaultError::MathOverflow)?;
    emit!(TaxConverted {
        launch: launch_key,
        tokens_in: spent,
        usdc_out,
        keeper_fee,
        price,
    });
    Ok(())
}
