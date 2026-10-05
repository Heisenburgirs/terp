//! The token's transfer hook. Token-2022 calls `transfer_hook` inside every transfer of a
//! launched token, so trading the token is what keeps its vault's position in its leverage band:
//! exposure is topped up under the minimum leverage and the position is cut above the maximum.
//!
//! A hook that fails makes the transfer fail, so this one does nothing unless it is safe to act:
//! every condition is checked before anything moves, and when in doubt the transfer simply goes
//! through. It cannot touch the tokens being transferred; Token-2022 passes those accounts
//! read-only.
use anchor_lang::{
    prelude::*,
    solana_program::{instruction::get_stack_height, program::invoke_signed, system_instruction},
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions},
    state::Account as TokenAccountState,
};

use super::{perp, venue::*};
use crate::{
    constants::*,
    error::VaultError,
    phoenix::TraderHeader,
    state::{Launch, ProtocolConfig},
};

/// The compute-unit limit the transaction asked for, if it set one.
///
/// A program cannot ask how much compute is left on mainnet, so the hook reads what the sender
/// requested instead. A sender who asks for a large limit has budgeted for the rebalance; an
/// ordinary wallet transfer has not, and running out of compute would fail the transfer.
fn requested_compute_units(instructions: &AccountInfo) -> u32 {
    let Ok(data) = instructions.try_borrow_data() else {
        return 0;
    };
    // Instructions sysvar layout: u16 count, then one u16 offset per instruction; at each
    // offset: u16 account count, 33 bytes per account, the program id, u16 data length, data.
    let u16_at = |at: usize| -> Option<usize> {
        Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?) as usize)
    };
    let Some(count) = u16_at(0) else { return 0 };
    for index in 0..count {
        let found = (|| {
            let start = u16_at(2 + index * 2)?;
            let program_at = start + 2 + u16_at(start)? * 33;
            let program = data.get(program_at..program_at + 32)?;
            let len = u16_at(program_at + 32)?;
            let ix = data.get(program_at + 34..program_at + 34 + len)?;
            // SetComputeUnitLimit is instruction 2 of the compute budget program
            (program == COMPUTE_BUDGET_PROGRAM_ID.as_ref() && len == 5 && ix[0] == 2)
                .then(|| u32::from_le_bytes(ix[1..5].try_into().unwrap()))
        })();
        if let Some(units) = found {
            return units;
        }
    }
    0
}

/// Accounts the hook needs besides the transfer's own, in the order Token-2022 appends them.
/// Token-2022 can resolve about fifteen extra accounts before it runs out of memory, so this is
/// the position's valuation and order accounts only: no collateral accounts. Depositing idle
/// USDC stays with `deploy` and `rebalance`.
#[derive(Accounts)]
pub struct HookWork<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    pub desk: DeskAccounts<'info>,
    /// CHECK: address-constrained
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Writability of the `HookWork` accounts, in order: config, launch, 8 desk accounts, the
/// instructions sysvar.
const WORK_WRITABLE: [bool; 11] = [
    false, true, // config, launch
    false, false, true, true, true, true, true, false, // desk
    false, // instructions sysvar
];

#[derive(Accounts)]
pub struct InitHook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the list of extra accounts Token-2022 reads for this mint; written here
    #[account(mut, seeds = [HOOK_SEED, launch.mint.as_ref()], bump)]
    pub extra_account_metas: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    pub desk: DeskAccounts<'info>,
    /// CHECK: address-constrained
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Writes the list of accounts every transfer of this token must carry for the hook. Anyone may
/// call it, again whenever Phoenix's account set changes: the list is fully determined by the
/// launch and by Phoenix's own configuration, which are validated here. `remaining_accounts` is
/// the exchange's trader-index tail.
pub fn init_hook<'info>(ctx: Context<'info, InitHook<'info>>) -> Result<()> {
    let accounts = &ctx.accounts;
    // Token-2022 refuses every transfer of a hooked mint whose list does not exist, so the
    // list is first written empty, right when the launch is created. Once the launch has its
    // Phoenix trader account, it is rewritten with the accounts the hook works with.
    let mut metas: Vec<(Pubkey, bool)> = Vec::new();
    if accounts.launch.is_trader_registered() {
        // pins every account to this launch and to Phoenix's configuration
        Desk::load(&accounts.launch, &accounts.desk, ctx.remaining_accounts)?;
        // the order `HookWork` reads them in
        let mut work = vec![
            accounts.config.to_account_info(),
            accounts.launch.to_account_info(),
        ];
        work.extend(accounts.desk.to_account_infos());
        work.push(accounts.instructions.to_account_info());
        metas = work
            .iter()
            .zip(WORK_WRITABLE)
            .map(|(info, writable)| (info.key(), writable))
            .collect();
        require!(
            metas.len() == WORK_WRITABLE.len(),
            VaultError::InvalidHookAccount
        );
        metas.extend(ctx.remaining_accounts.iter().map(|info| (info.key(), true)));
    }

    // Token-2022 cannot resolve a longer list: every transfer of the token would fail. An empty
    // list switches the hook off instead, and upkeep falls back to `rebalance`.
    if metas.len() > HOOK_MAX_ACCOUNTS {
        metas.clear();
    }

    // spl-tlv-account-resolution layout: one TLV entry for the `execute` instruction holding a
    // length-prefixed array of 35-byte account metas; type 0 is a literal address
    let value_len = 4 + metas.len() * 35;
    let mut data = Vec::with_capacity(12 + value_len);
    data.extend_from_slice(&EXECUTE_DISCRIMINATOR);
    data.extend_from_slice(&(value_len as u32).to_le_bytes());
    data.extend_from_slice(&(metas.len() as u32).to_le_bytes());
    for (key, writable) in &metas {
        data.push(0);
        data.extend_from_slice(key.as_ref());
        data.push(0);
        data.push(*writable as u8);
    }

    let list = accounts.extra_account_metas.to_account_info();
    let mint = accounts.launch.mint;
    let seeds: &[&[u8]] = &[HOOK_SEED, mint.as_ref(), &[ctx.bumps.extra_account_metas]];
    let rent = Rent::get()?.minimum_balance(data.len());
    if list.data_is_empty() && *list.owner != crate::ID {
        invoke_signed(
            &system_instruction::create_account(
                accounts.payer.key,
                list.key,
                rent,
                data.len() as u64,
                &crate::ID,
            ),
            &[accounts.payer.to_account_info(), list.clone()],
            &[seeds],
        )?;
    } else {
        let missing = rent.saturating_sub(list.lamports());
        if missing > 0 {
            anchor_lang::solana_program::program::invoke(
                &system_instruction::transfer(accounts.payer.key, list.key, missing),
                &[accounts.payer.to_account_info(), list.clone()],
            )?;
        }
        list.resize(data.len())?;
    }
    list.try_borrow_mut_data()?.copy_from_slice(&data);
    Ok(())
}

/// What Token-2022 passes to every hook: the transfer's own accounts, read-only, then the
/// extra-account list, then the accounts on that list.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// CHECK: checked to be a token account of `mint` that is mid-transfer
    pub source: UncheckedAccount<'info>,
    /// CHECK: only its address is used
    pub mint: UncheckedAccount<'info>,
    /// CHECK: unused
    pub destination: UncheckedAccount<'info>,
    /// CHECK: unused
    pub authority: UncheckedAccount<'info>,
    /// CHECK: address-constrained
    #[account(seeds = [HOOK_SEED, mint.key().as_ref()], bump)]
    pub extra_account_metas: UncheckedAccount<'info>,
}

pub fn transfer_hook<'info>(ctx: Context<'info, TransferHook<'info>>, _amount: u64) -> Result<()> {
    // Only Token-2022 can set `transferring` on an account, so this cannot be called directly.
    {
        let source = &ctx.accounts.source;
        require_keys_eq!(
            *source.owner,
            spl_token_2022::ID,
            VaultError::NotTransferring
        );
        let data = source.try_borrow_data()?;
        let state = StateWithExtensions::<TokenAccountState>::unpack(&data)
            .map_err(|_| error!(VaultError::NotTransferring))?;
        require_keys_eq!(
            state.base.mint,
            ctx.accounts.mint.key(),
            VaultError::NotTransferring
        );
        let hook = state
            .get_extension::<TransferHookAccount>()
            .map_err(|_| error!(VaultError::NotTransferring))?;
        require!(bool::from(hook.transferring), VaultError::NotTransferring);
    }

    // From here on nothing may fail the transfer unless funds have already moved.

    // before `init_hook`, a transfer carries no extra accounts
    if ctx.remaining_accounts.len() < WORK_WRITABLE.len() {
        return Ok(());
    }
    // Acting takes two more levels of program calls. Called from a transfer or a direct pool
    // swap that fits; called from deeper (an aggregator route) it does not, so stand aside.
    if get_stack_height() > HOOK_MAX_STACK_HEIGHT {
        return Ok(());
    }

    let mut remaining = ctx.remaining_accounts;
    let mut bumps = HookWorkBumps::default();
    let mut reallocs = std::collections::BTreeSet::new();
    let mut work =
        HookWork::try_accounts(&crate::ID, &mut remaining, &[], &mut bumps, &mut reallocs)?;
    require_keys_eq!(
        work.launch.mint,
        ctx.accounts.mint.key(),
        VaultError::InvalidHookAccount
    );

    if requested_compute_units(&work.instructions) < HOOK_MIN_COMPUTE_UNITS {
        return Ok(());
    }

    let slot = Clock::get()?.slot;
    // until Phoenix has enabled the launch's trader account, its orders fail
    let onboarded = work.launch.is_trader_registered()
        && work.desk.trader_account.key() == work.launch.trader_account
        && TraderHeader::load(&work.desk.trader_account)
            .map(|header| header.is_onboarded())
            .unwrap_or(false);
    if work.config.paused
        || !onboarded
        || slot
            < work
                .launch
                .last_rebalance_slot
                .saturating_add(HOOK_MIN_INTERVAL_SLOTS)
    {
        return Ok(());
    }
    // one attempt per interval, whether or not it finds work: a view of the account is not free
    work.launch.last_rebalance_slot = slot;

    let (deployed, deleveraged) = {
        // a list that no longer matches Phoenix's accounts is a reason to stand aside, not to fail
        let Ok(desk) = Desk::load(&work.launch, &work.desk, remaining) else {
            return work.exit(&crate::ID);
        };
        let before = desk.view()?;
        if before.notional > 0 && before.leverage_bps() > work.launch.max_leverage_bps as u64 {
            let cut = perp::run_deleverage(&work.launch, &desk, before, crate::ID, true)?;
            (None, cut)
        } else {
            (perp::run_top_up(&work.launch, &desk, before)?, None)
        }
    };
    if let Some(event) = deployed {
        perp::record_deploy(&mut work.launch, event)?;
    }
    if let Some(event) = deleveraged {
        emit!(event);
    }
    work.exit(&crate::ID)
}
