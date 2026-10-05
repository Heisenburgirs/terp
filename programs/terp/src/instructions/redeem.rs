use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{self, BurnChecked, Mint, TokenAccount, TransferChecked},
};

use super::venue::*;
use crate::{
    constants::*,
    error::VaultError,
    events::{ClaimPaid, Redeemed, ResidualSwept},
    math,
    phoenix::PerpView,
    state::{Claim, Launch, ProtocolConfig},
};

/// `remaining_accounts` is the Phoenix trader-index tail. Before the launch has a Phoenix trader
/// the Phoenix accounts are not used and only need to be the right addresses.
#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [LAUNCH_SEED, mint.key().as_ref()], bump = launch.bump, has_one = mint)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_2022_program)]
    pub token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = USDC_MINT, token::authority = owner)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Holds what is still owed if Phoenix queues the withdrawal; closed again otherwise.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Claim::INIT_SPACE,
        seeds = [CLAIM_SEED, launch.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub claim: Box<Account<'info, Claim>>,
    pub phoenix: PhoenixAccounts<'info>,
    pub ember: EmberAccounts<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Burns `amount` tokens for their share of net vault equity, in one transaction.
///
/// ```text
/// gross  = floor(q * E / S)                     E is net of outstanding claims
/// payout = gross - 3% redemption fee - exit cost
/// exit cost = max(0.05% of the slice's notional, what closing the slice actually cost)
/// ```
///
/// `S` and `E` are read here, at Phoenix's current mark. If the vault's idle USDC does not cover
/// the payout, the program closes the redeemer's proportional share of the position and
/// withdraws the difference from Phoenix, all inside this instruction, so collateral never
/// leaves Phoenix without the matching reduction and never for anyone but a redeemer who burns.
///
/// Phoenix throttles withdrawals exchange-wide. If it queues this one instead of paying, the
/// tokens are still burned and the unpaid part becomes a fixed USDC claim, paid by
/// `pay_claim` when the USDC arrives.
pub fn redeem<'info>(
    ctx: Context<'info, Redeem<'info>>,
    amount: u64,
    min_payout: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let launch = &accounts.launch;
    require!(
        amount >= launch.min_redeem_tokens && amount <= accounts.token_account.amount,
        VaultError::RedemptionTooSmall
    );
    require_keys_eq!(
        accounts.ember.vault_usdc.key(),
        launch.vault_usdc,
        VaultError::InvalidPhoenixAccount
    );

    let mint_key = accounts.mint.key();
    let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[launch.bump]];
    let vault_usdc = accounts.ember.vault_usdc.to_account_info();
    let claims = launch.pending_claims;
    let supply = accounts.mint.supply;

    let venue = if launch.is_trader_registered() {
        Some(Venue::load(
            launch,
            &accounts.phoenix,
            &accounts.ember,
            ctx.remaining_accounts,
        )?)
    } else {
        None
    };
    let (view, canonical) = match &venue {
        Some(venue) => {
            let view = venue.view()?;
            if view.notional > 0 {
                venue.require_fresh_mark()?;
            }
            (view, venue.canonical()?)
        }
        None => (PerpView::default(), 0),
    };

    let idle = accounts.ember.vault_usdc.amount;
    let equity = math::vault_equity(idle, canonical, view.equity())?.saturating_sub(claims);
    let quote = math::quote_redemption(
        amount,
        supply,
        equity,
        view.notional,
        launch.redemption_fee_bps,
        launch.exit_cost_bps,
    )?;
    let mut payout = quote.payout;
    let mut exit_cost = quote.exit_cost;
    require!(payout >= min_payout, VaultError::PayoutBelowMinimum);

    // free liquidity: close this redeemer's share of the position, withdraw what is missing
    let mut lots_closed = 0;
    let mut withdrawn = 0;
    let free = idle.saturating_sub(claims);
    if let Some(venue) = venue.as_ref().filter(|_| payout > free || quote.is_final) {
        let lots = math::pro_rata_ceil(view.base_lots.unsigned_abs(), amount, supply)?;
        if lots > 0 {
            lots_closed = venue
                .order(false, lots, view.mark_price_ticks, seeds)?
                .base_lots;
        }
        let after = venue.view()?;
        let want = if quote.is_final {
            // the last holder takes whatever is left once the whole position is closed
            require!(after.notional == 0, VaultError::ReductionIncomplete);
            after.collateral.max(0) as u64
        } else {
            // The redeemer pays what closing their slice actually cost (taker fee and
            // slippage, measured as the fall in account equity across the fill), never less
            // than the flat estimate. The holders who stay do not pay for the exit.
            let realized = view.equity().saturating_sub(after.equity()).max(0) as u64;
            exit_cost = exit_cost
                .max(realized)
                .min(quote.gross - quote.redemption_fee);
            payout = quote.gross - quote.redemption_fee - exit_cost;
            require!(payout >= min_payout, VaultError::PayoutBelowMinimum);

            // collateral leaves only with the matching reduction: leverage once the
            // withdrawal is paid may not exceed the higher of target and what it was
            let want = payout.saturating_sub(free);
            let equity_after = after.equity().saturating_sub(want as i64);
            require!(
                after.notional == 0
                    || math::leverage_bps(after.notional, equity_after)
                        <= with_tolerance(
                            view.leverage_bps().max(launch.target_leverage_bps as u64)
                        ),
                VaultError::ReductionIncomplete
            );
            want
        };
        if want > 0 {
            withdrawn = venue.withdraw(want, seeds)?;
        }
    }
    let free = super::venue::token_amount(&vault_usdc)?.saturating_sub(claims);
    if quote.is_final {
        payout = free;
        require!(payout >= min_payout, VaultError::PayoutBelowMinimum);
    }
    let paid = payout.min(free);
    let owed = payout - paid;
    // only a queued Phoenix withdrawal may leave part of a payout owed
    require!(owed == 0 || venue.is_some(), VaultError::PayoutBelowMinimum);

    // burning is not a transfer: no Token-2022 transfer fee applies
    token_interface::burn_checked(
        CpiContext::new(
            accounts.token_2022_program.key(),
            BurnChecked {
                mint: accounts.mint.to_account_info(),
                from: accounts.token_account.to_account_info(),
                authority: accounts.owner.to_account_info(),
            },
        ),
        amount,
        accounts.mint.decimals,
    )?;
    if paid > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                accounts.ember.token_program.key(),
                TransferChecked {
                    from: vault_usdc,
                    mint: accounts.ember.usdc_mint.to_account_info(),
                    to: accounts.owner_usdc.to_account_info(),
                    authority: launch.to_account_info(),
                },
                &[seeds],
            ),
            paid,
            USDC_DECIMALS,
        )?;
    }

    let event = Redeemed {
        launch: launch.key(),
        owner: accounts.owner.key(),
        tokens_burned: amount,
        supply_before: supply,
        equity,
        notional: view.notional,
        gross: quote.gross,
        redemption_fee: quote.redemption_fee,
        exit_cost,
        payout,
        paid,
        owed,
        base_lots_closed: lots_closed,
        usdc_withdrawn: withdrawn,
    };
    drop(venue);

    let claim_bump = ctx.bumps.claim;
    let owner_info = ctx.accounts.owner.to_account_info();
    let claim = &mut ctx.accounts.claim;
    claim.launch = event.launch;
    claim.owner = event.owner;
    claim.bump = claim_bump;
    claim.amount = claim
        .amount
        .checked_add(owed)
        .ok_or(VaultError::MathOverflow)?;
    if claim.amount == 0 {
        claim.close(owner_info)?;
    }

    let launch = &mut ctx.accounts.launch;
    launch.pending_claims = launch
        .pending_claims
        .checked_add(owed)
        .ok_or(VaultError::MathOverflow)?;
    launch.usdc_withdrawn = launch
        .usdc_withdrawn
        .checked_add(withdrawn)
        .ok_or(VaultError::MathOverflow)?;
    launch.tokens_redeemed = launch
        .tokens_redeemed
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;
    launch.usdc_redeemed = launch
        .usdc_redeemed
        .checked_add(payout)
        .ok_or(VaultError::MathOverflow)?;
    launch.redemption_fees_retained = launch
        .redemption_fees_retained
        .checked_add(quote.redemption_fee)
        .ok_or(VaultError::MathOverflow)?;
    launch.exit_costs_retained = launch
        .exit_costs_retained
        .checked_add(exit_cost)
        .ok_or(VaultError::MathOverflow)?;
    emit!(event);
    Ok(())
}

#[derive(Accounts)]
pub struct PayClaim<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump, has_one = vault_usdc)]
    pub launch: Box<Account<'info, Launch>>,
    /// CHECK: the claim's owner; receives the claim account's rent when it is paid in full
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [CLAIM_SEED, launch.key().as_ref(), owner.key().as_ref()],
        bump = claim.bump,
        has_one = owner,
        has_one = launch,
    )]
    pub claim: Box<Account<'info, Claim>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Pays a redeemer's claim from the vault's idle USDC, as much as is there. Callable by anyone;
/// the money can only go to the claim's owner.
pub fn pay_claim(ctx: Context<PayClaim>) -> Result<()> {
    let accounts = &ctx.accounts;
    let usdc = accounts.claim.amount.min(accounts.vault_usdc.amount);
    require!(usdc > 0, VaultError::NothingToPay);

    let mint_key = accounts.launch.mint;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.vault_usdc.to_account_info(),
                mint: accounts.usdc_mint.to_account_info(),
                to: accounts.owner_usdc.to_account_info(),
                authority: accounts.launch.to_account_info(),
            },
            &[&[LAUNCH_SEED, mint_key.as_ref(), &[accounts.launch.bump]]],
        ),
        usdc,
        accounts.usdc_mint.decimals,
    )?;

    let owner_info = ctx.accounts.owner.to_account_info();
    let launch = &mut ctx.accounts.launch;
    launch.pending_claims = launch.pending_claims.saturating_sub(usdc);
    let claim = &mut ctx.accounts.claim;
    claim.amount -= usdc;
    emit!(ClaimPaid {
        launch: launch.key(),
        owner: claim.owner,
        usdc,
        remaining: claim.amount,
    });
    if claim.amount == 0 {
        claim.close(owner_info)?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct SweepResidual<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds = [LAUNCH_SEED, mint.key().as_ref()], bump = launch.bump, has_one = mint, has_one = vault_usdc)]
    pub launch: Box<Account<'info, Launch>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = config.treasury)]
    pub treasury_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Once every token has been burned and every claim paid, nobody has a claim on the vault any
/// more. Whatever USDC reaches it afterwards goes to the protocol treasury.
pub fn sweep_residual(ctx: Context<SweepResidual>) -> Result<()> {
    let accounts = &ctx.accounts;
    require!(
        accounts.mint.supply == 0 && accounts.launch.pending_claims == 0,
        VaultError::SupplyNotZero
    );
    let amount = accounts.vault_usdc.amount;
    require!(amount > 0, VaultError::NothingToPay);

    let mint_key = accounts.mint.key();
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.vault_usdc.to_account_info(),
                mint: accounts.usdc_mint.to_account_info(),
                to: accounts.treasury_usdc.to_account_info(),
                authority: accounts.launch.to_account_info(),
            },
            &[&[LAUNCH_SEED, mint_key.as_ref(), &[accounts.launch.bump]]],
        ),
        amount,
        accounts.usdc_mint.decimals,
    )?;
    emit!(ResidualSwept {
        launch: accounts.launch.key(),
        usdc: amount,
    });
    Ok(())
}
