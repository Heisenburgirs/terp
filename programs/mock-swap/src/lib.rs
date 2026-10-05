//! MOCK. A minimal constant-product token/USDC pool that stands in for Meteora DLMM in local
//! tests only. It is never deployed to mainnet and is not part of the product.
//!
//! It exists so tests can exercise `terp::convert_tax` against an AMM that handles a
//! Token-2022 transfer-fee mint the way a real pool does: the pool prices the amount it actually
//! receives after the transfer fee.
use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};

declare_id!("39NpxonaWZ3CWr4BgTi8F18UZZ8h4uMUucaP1k6uNNbg");

#[program]
pub mod mock_swap {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        ctx.accounts.pool.set_inner(Pool {
            token_mint: ctx.accounts.token_mint.key(),
            token_vault: ctx.accounts.token_vault.key(),
            usdc_vault: ctx.accounts.usdc_vault.key(),
            bump: ctx.bumps.pool,
        });
        Ok(())
    }

    /// Sells `amount_in` tokens for USDC at the constant-product price, no pool fee.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_out: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        let token_before = accounts.token_vault.amount;
        let usdc_reserve = accounts.usdc_vault.amount;

        token_interface::transfer_checked(
            CpiContext::new(
                accounts.token_2022_program.key(),
                TransferChecked {
                    from: accounts.user_token.to_account_info(),
                    mint: accounts.token_mint.to_account_info(),
                    to: accounts.token_vault.to_account_info(),
                    authority: accounts.user.to_account_info(),
                },
            ),
            amount_in,
            accounts.token_mint.decimals,
        )?;
        ctx.accounts.token_vault.reload()?;
        let received = ctx.accounts.token_vault.amount - token_before;

        let out = (usdc_reserve as u128 * received as u128
            / (token_before as u128 + received as u128)) as u64;
        require!(out >= min_out, MockSwapError::Slippage);

        let accounts = &ctx.accounts;
        let token_mint = accounts.pool.token_mint;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                TransferChecked {
                    from: accounts.usdc_vault.to_account_info(),
                    mint: accounts.usdc_mint.to_account_info(),
                    to: accounts.user_usdc.to_account_info(),
                    authority: accounts.pool.to_account_info(),
                },
                &[&[b"pool", token_mint.as_ref(), &[accounts.pool.bump]]],
            ),
            out,
            accounts.usdc_mint.decimals,
        )?;
        Ok(())
    }

    /// Takes tokens and pays nothing. Lets tests prove the vault rejects a swap that does not
    /// deliver USDC.
    pub fn swap_and_keep(ctx: Context<Swap>, amount_in: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                accounts.token_2022_program.key(),
                TransferChecked {
                    from: accounts.user_token.to_account_info(),
                    mint: accounts.token_mint.to_account_info(),
                    to: accounts.token_vault.to_account_info(),
                    authority: accounts.user.to_account_info(),
                },
            ),
            amount_in,
            accounts.token_mint.decimals,
        )
    }
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub token_mint: Pubkey,
    pub token_vault: Pubkey,
    pub usdc_vault: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Pool::INIT_SPACE, seeds = [b"pool", token_mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = token_mint, token::authority = pool)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(token::authority = pool)]
    pub usdc_vault: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(seeds = [b"pool", token_mint.key().as_ref()], bump = pool.bump, has_one = token_mint, has_one = token_vault, has_one = usdc_vault)]
    pub pool: Account<'info, Pool>,
    pub user: Signer<'info>,
    pub token_mint: InterfaceAccount<'info, Mint>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub usdc_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[error_code]
pub enum MockSwapError {
    #[msg("Output below minimum")]
    Slippage,
}
