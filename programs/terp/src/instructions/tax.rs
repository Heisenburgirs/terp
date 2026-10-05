use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{get_stack_height, AccountMeta, Instruction, TRANSACTION_LEVEL_STACK_HEIGHT},
    program::invoke_signed,
};
use anchor_spl::{
    token::Token,
    token_2022::{
        spl_token_2022::{self, extension::transfer_fee::instruction as fee_ix},
        Token2022,
    },
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};

use crate::{
    constants::*,
    error::VaultError,
    events::{TaxCollected, TaxConverted},
    introspect, math,
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
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
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
    /// The platform treasury's USDC account, for the platform fee.
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
/// Open to anyone. The caller supplies the AMM's swap instruction (accounts in `remaining_accounts`, data in
/// `swap_data`), but the program does not rely on the caller being honest or careful:
///
/// - the batch size is fixed by the program: the tax balance, capped at `max_convert_tokens`,
///   and only once it has reached `min_convert_tokens` and the cooldown has passed;
/// - the program signs only as the tax authority, which owns nothing but the tax tokens;
/// - the sale must realize at least the reference price less `max_price_drop_bps` per cooldown
///   period elapsed. The reference starts at the pool's launch price and follows a running
///   average of conversions;
/// - the pool's proceeds are split in this instruction: the launch's fixed platform fee to the
///   platform treasury, everything else to the launch's vault. Neither destination is the
///   caller's to choose.
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

    let tokens_before = ctx.accounts.tax_account.amount;
    let usdc_before = ctx.accounts.tax_usdc.amount;
    let batch = sale_batch(launch, tokens_before, tokens_in)?;

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
    let accounts = &mut *ctx.accounts;
    finish_sale(
        &mut accounts.launch,
        SaleLegs {
            batch,
            tokens_in,
            tokens_before,
            usdc_before,
            tokens_now: accounts.tax_account.amount,
            usdc_now: accounts.tax_usdc.amount,
        },
        SaleAccounts {
            tax_authority: accounts.tax_authority.to_account_info(),
            tax_usdc: accounts.tax_usdc.to_account_info(),
            vault_usdc: accounts.vault_usdc.to_account_info(),
            treasury_usdc: accounts.treasury_usdc.to_account_info(),
            usdc_mint: accounts.usdc_mint.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
            usdc_decimals: accounts.usdc_mint.decimals,
        },
    )
}

/// The batch a sale is sized from: the tax balance capped at `max_convert_tokens`, available
/// only at or above `min_convert_tokens` and after the cooldown. `tokens_in` may be a little
/// under it (tax can arrive between building and landing the transaction), never dust.
fn sale_batch(launch: &Launch, tokens_before: u64, tokens_in: u64) -> Result<u64> {
    let elapsed = Clock::get()?.slot.saturating_sub(launch.last_convert_slot);
    require!(
        launch.tokens_converted == 0 || elapsed >= launch.convert_cooldown_slots,
        VaultError::ConversionCooldown
    );
    require!(
        tokens_before >= launch.min_convert_tokens,
        VaultError::ConversionTooSmall
    );
    let batch = tokens_before.min(launch.max_convert_tokens);
    require!(
        tokens_in <= batch && (tokens_in as u128) * 10 >= (batch as u128) * 9,
        VaultError::ConversionWrongSize
    );
    Ok(batch)
}

struct SaleLegs {
    batch: u64,
    tokens_in: u64,
    tokens_before: u64,
    usdc_before: u64,
    tokens_now: u64,
    usdc_now: u64,
}

struct SaleAccounts<'info> {
    tax_authority: AccountInfo<'info>,
    tax_usdc: AccountInfo<'info>,
    vault_usdc: AccountInfo<'info>,
    treasury_usdc: AccountInfo<'info>,
    usdc_mint: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    usdc_decimals: u8,
}

/// Judges a sale by what it did to the tax accounts, then splits the proceeds: the launch's
/// fixed platform fee to the treasury, everything else to the vault.
fn finish_sale<'info>(
    launch: &mut Account<'info, Launch>,
    legs: SaleLegs,
    accounts: SaleAccounts<'info>,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let elapsed = slot.saturating_sub(launch.last_convert_slot);
    let spent = legs
        .tokens_before
        .checked_sub(legs.tokens_now)
        .ok_or(VaultError::MathOverflow)?;
    let usdc_out = legs
        .usdc_now
        .checked_sub(legs.usdc_before)
        .ok_or(VaultError::SlippageExceeded)?;
    require!(
        spent <= legs.tokens_in && (spent as u128) * 10 >= (legs.batch as u128) * 9,
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

    let platform_fee = math::bps_of(usdc_out, launch.platform_fee_bps);
    let to_vault = legs.usdc_now - platform_fee;
    let launch_key = launch.key();
    let tax_seeds: &[&[&[u8]]] = &[&[TAX_SEED, launch_key.as_ref(), &[launch.tax_bump]]];
    for (to, amount) in [
        (accounts.treasury_usdc.clone(), platform_fee),
        (accounts.vault_usdc.clone(), to_vault),
    ] {
        if amount == 0 {
            continue;
        }
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                TransferChecked {
                    from: accounts.tax_usdc.clone(),
                    mint: accounts.usdc_mint.clone(),
                    to,
                    authority: accounts.tax_authority.clone(),
                },
                tax_seeds,
            ),
            amount,
            accounts.usdc_decimals,
        )?;
    }

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
    launch.platform_fees_paid = launch
        .platform_fees_paid
        .checked_add(platform_fee)
        .ok_or(VaultError::MathOverflow)?;
    emit!(TaxConverted {
        launch: launch_key,
        tokens_in: spent,
        usdc_out,
        platform_fee,
        price,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct BeginTaxSale<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [LAUNCH_SEED, launch.mint.as_ref()],
        bump = launch.bump,
        has_one = mint,
        has_one = tax_account,
        has_one = tax_usdc,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    /// CHECK: PDA that owns the tax account; approves the caller for one batch.
    #[account(seeds = [TAX_SEED, launch.key().as_ref()], bump = launch.tax_bump)]
    pub tax_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub tax_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub tax_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: address-constrained
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Opens a tax sale that the caller's own transaction carries out, for tokens whose transfers
/// call back into this program (a transfer hook): Solana does not let this program start a swap
/// that ends up calling it again, so here the pool is called by the transaction, not by us.
///
/// Open to anyone. The transaction must be exactly: this instruction, then the allowlisted
/// swap on the launch's pool selling from the tax account into the tax authority's USDC
/// account, then `settle_tax_sale`. That is checked here, before anything is approved. For the
/// length of that swap the caller may move `tokens_in` out of the tax account; `settle_tax_sale`
/// takes the approval back and applies the same size, price and destination rules as
/// `convert_tax`, failing the whole transaction if they are not met.
pub fn begin_tax_sale(ctx: Context<BeginTaxSale>, tokens_in: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let (config, launch) = (&accounts.config, &accounts.launch);
    require!(!config.paused, VaultError::Paused);
    require!(
        launch.pool != Pubkey::default(),
        VaultError::SwapPoolMissing
    );
    require!(launch.sale_tokens_in == 0, VaultError::SaleState);
    // not from inside another program, which could use the approval before the swap runs
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        VaultError::SaleNotWellFormed
    );

    let tokens_before = accounts.tax_account.amount;
    let batch = sale_batch(launch, tokens_before, tokens_in)?;

    {
        let sysvar = accounts.instructions.try_borrow_data()?;
        let index = introspect::current_index(&sysvar).ok_or(VaultError::SaleNotWellFormed)?;
        let swap =
            introspect::instruction_at(&sysvar, index + 1).ok_or(VaultError::SaleNotWellFormed)?;
        require!(
            swap.program_id == config.swap_program
                && swap.data.len() >= 8
                && config.swap_discriminators[..config.swap_discriminator_count as usize]
                    .iter()
                    .any(|d| d[..] == swap.data[..8]),
            VaultError::SwapNotAllowed
        );
        require!(
            swap.accounts.get(SWAP_POOL_INDEX) == Some(&launch.pool)
                && swap.accounts.get(SWAP_TOKEN_IN_INDEX) == Some(&launch.tax_account)
                && swap.accounts.get(SWAP_TOKEN_OUT_INDEX) == Some(&launch.tax_usdc),
            VaultError::SaleNotWellFormed
        );
        let settle =
            introspect::instruction_at(&sysvar, index + 2).ok_or(VaultError::SaleNotWellFormed)?;
        require!(
            settle.program_id == crate::ID
                && settle.data[..] == *crate::instruction::SettleTaxSale::DISCRIMINATOR
                && settle.accounts.get(1) == Some(&launch.key()),
            VaultError::SaleNotWellFormed
        );
    }

    let launch_key = launch.key();
    invoke_signed(
        &spl_token_2022::instruction::approve_checked(
            &spl_token_2022::ID,
            &accounts.tax_account.key(),
            &accounts.mint.key(),
            accounts.caller.key,
            accounts.tax_authority.key,
            &[],
            tokens_in,
            accounts.mint.decimals,
        )?,
        &[
            accounts.tax_account.to_account_info(),
            accounts.mint.to_account_info(),
            accounts.caller.to_account_info(),
            accounts.tax_authority.to_account_info(),
        ],
        &[&[TAX_SEED, launch_key.as_ref(), &[launch.tax_bump]]],
    )?;

    let usdc_before = accounts.tax_usdc.amount;
    let launch = &mut ctx.accounts.launch;
    launch.sale_batch = batch;
    launch.sale_tokens_in = tokens_in;
    launch.sale_tokens_before = tokens_before;
    launch.sale_usdc_before = usdc_before;
    Ok(())
}

#[derive(Accounts)]
pub struct SettleTaxSale<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [LAUNCH_SEED, launch.mint.as_ref()],
        bump = launch.bump,
        has_one = tax_account,
        has_one = tax_usdc,
        has_one = vault_usdc,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    /// CHECK: PDA that owns the tax account and the pass-through USDC account.
    #[account(seeds = [TAX_SEED, launch.key().as_ref()], bump = launch.tax_bump)]
    pub tax_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub tax_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub tax_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The platform treasury's USDC account, for the platform fee.
    #[account(mut, token::mint = usdc_mint, token::authority = config.treasury)]
    pub treasury_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Closes the sale `begin_tax_sale` opened earlier in the same transaction: takes the caller's
/// approval back, then judges the swap by what it did to the tax accounts and splits the
/// proceeds, exactly as `convert_tax` does.
pub fn settle_tax_sale(ctx: Context<SettleTaxSale>) -> Result<()> {
    let accounts = &mut *ctx.accounts;
    require!(accounts.launch.sale_tokens_in > 0, VaultError::SaleState);

    let launch_key = accounts.launch.key();
    invoke_signed(
        &spl_token_2022::instruction::revoke(
            &spl_token_2022::ID,
            &accounts.tax_account.key(),
            accounts.tax_authority.key,
            &[],
        )?,
        &[
            accounts.tax_account.to_account_info(),
            accounts.tax_authority.to_account_info(),
        ],
        &[&[TAX_SEED, launch_key.as_ref(), &[accounts.launch.tax_bump]]],
    )?;

    let legs = SaleLegs {
        batch: accounts.launch.sale_batch,
        tokens_in: accounts.launch.sale_tokens_in,
        tokens_before: accounts.launch.sale_tokens_before,
        usdc_before: accounts.launch.sale_usdc_before,
        tokens_now: accounts.tax_account.amount,
        usdc_now: accounts.tax_usdc.amount,
    };
    accounts.launch.sale_batch = 0;
    accounts.launch.sale_tokens_in = 0;
    accounts.launch.sale_tokens_before = 0;
    accounts.launch.sale_usdc_before = 0;
    finish_sale(
        &mut accounts.launch,
        legs,
        SaleAccounts {
            tax_authority: accounts.tax_authority.to_account_info(),
            tax_usdc: accounts.tax_usdc.to_account_info(),
            vault_usdc: accounts.vault_usdc.to_account_info(),
            treasury_usdc: accounts.treasury_usdc.to_account_info(),
            usdc_mint: accounts.usdc_mint.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
            usdc_decimals: accounts.usdc_mint.decimals,
        },
    )
}
