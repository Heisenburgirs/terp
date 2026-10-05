//! CPI layer for Phoenix perpetuals (program "Eternal"), Ember (USDC <-> Phoenix canonical
//! collateral token) and Hawkeye (read-only margin views).
//!
//! Instruction and account layouts follow the public Rise SDK (`phoenix-rise-ix`, MIT). They are
//! encoded by hand because the SDK's CPI surface is Pinocchio-typed. The LiteSVM suite runs this
//! module against the deployed mainnet Phoenix binaries.
//!
//! This is Phoenix *perps*. It shares nothing with the Phoenix v1 spot order book
//! (`PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY`).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, invoke_signed},
};

use crate::error::VaultError;

pub const PHOENIX_PROGRAM_ID: Pubkey = pubkey!("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
/// PDA `["log"]` of Phoenix.
pub const PHOENIX_LOG_AUTHORITY: Pubkey = pubkey!("GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS");
/// PDA `["global"]` of Phoenix.
pub const PHOENIX_GLOBAL_CONFIG: Pubkey = pubkey!("2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ");
pub const HAWKEYE_PROGRAM_ID: Pubkey = pubkey!("RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj");
pub const EMBER_PROGRAM_ID: Pubkey = pubkey!("EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy");
/// PDA `[PHOENIX_PROGRAM_ID, "state"]` of Ember.
pub const EMBER_STATE: Pubkey = pubkey!("6ur7v6AXNpnHeEb6xuk7PyezvZ1i5GrgYyWZkNCpzbRz");
/// PDA `[PHOENIX_PROGRAM_ID, "vault"]` of Ember, its USDC custody.
pub const EMBER_VAULT: Pubkey = pubkey!("FKcEb4TdPDTRuMnQDpSEPQBcrm15S73xiUD6Qf8ZLUkq");

/// Each launch uses one cross-margin trader account, index `(0, 0)` of its own authority.
pub const TRADER_PDA_INDEX: u8 = 0;
pub const TRADER_SUBACCOUNT_INDEX: u8 = 0;
/// One market per launch; Phoenix's minimum for a cross-margin account is 32.
pub const TRADER_MAX_POSITIONS: u32 = 32;

/// `sha256("global:<name>")[..8]`
mod ix {
    pub const REGISTER_TRADER: [u8; 8] = [75, 243, 224, 167, 1, 5, 51, 32];
    pub const DEPOSIT_FUNDS: [u8; 8] = [202, 39, 52, 211, 53, 20, 250, 88];
    pub const WITHDRAW_FUNDS: [u8; 8] = [241, 36, 29, 111, 208, 31, 104, 217];
    pub const PLACE_MARKET_ORDER: [u8; 8] = [90, 118, 192, 252, 192, 99, 39, 145];
    pub const EMBER_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
    pub const EMBER_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
    pub const VIEW_MARGIN_FOR_ASSET: [u8; 8] = [32, 18, 175, 254, 161, 237, 77, 155];
    pub const VIEW_BBO: [u8; 8] = [55, 95, 35, 45, 83, 175, 18, 82];
}

/// `sha256("account:<name>")[..8]`
mod account {
    pub const GLOBAL_CONFIGURATION: [u8; 8] = [37, 146, 212, 210, 47, 136, 111, 20];
    pub const TRADER: [u8; 8] = [41, 97, 73, 105, 110, 214, 112, 9];
    pub const GLOBAL_TRADER_INDEX: [u8; 8] = [145, 92, 169, 6, 5, 144, 1, 205];
    pub const ACTIVE_TRADER_BUFFER: [u8; 8] = [192, 255, 205, 165, 80, 154, 131, 5];
}

/// `sha256("return:<name>")[..8]`
mod ret {
    pub const ASSET: [u8; 8] = [185, 29, 94, 40, 248, 255, 88, 219];
    pub const BBO: [u8; 8] = [113, 65, 167, 31, 163, 31, 202, 239];
    pub const VERSION: u16 = 1;
    pub const ASSET_LEN: usize = 128;
    pub const BBO_LEN: usize = 64;
    pub const MATCHING_LEN: usize = 64;
}

const ORDER_PACKET_IOC: u8 = 2;
const SIDE_BID: u8 = 0;
const SIDE_ASK: u8 = 1;
const SELF_TRADE_CANCEL_PROVIDE: u8 = 1;
const ORDER_FLAG_REDUCE_ONLY: u8 = 128;

fn pk(data: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(data[at..at + 32].try_into().unwrap())
}
fn u16_at(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(data[at..at + 2].try_into().unwrap())
}
fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(data[at..at + 4].try_into().unwrap())
}
fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}
fn i64_at(data: &[u8], at: usize) -> i64 {
    i64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

fn check_phoenix_account(info: &AccountInfo, discriminator: [u8; 8], min_len: usize) -> Result<()> {
    require_keys_eq!(
        *info.owner,
        PHOENIX_PROGRAM_ID,
        VaultError::InvalidPhoenixAccount
    );
    let data = info.try_borrow_data()?;
    require!(
        data.len() >= min_len && data[..8] == discriminator,
        VaultError::InvalidPhoenixAccount
    );
    Ok(())
}

/// PDA `["trader", authority, [pda_index, subaccount_index]]` of Phoenix.
pub fn trader_address(authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"trader",
            authority.as_ref(),
            &[TRADER_PDA_INDEX, TRADER_SUBACCOUNT_INDEX],
        ],
        &PHOENIX_PROGRAM_ID,
    )
    .0
}

/// Exchange-wide accounts named by the Phoenix global configuration account.
#[derive(Clone, Copy, Debug)]
pub struct Exchange {
    pub canonical_mint: Pubkey,
    pub global_vault: Pubkey,
    pub perp_asset_map: Pubkey,
    pub global_trader_index: Pubkey,
    pub active_trader_buffer: Pubkey,
    pub withdraw_queue: Pubkey,
}

impl Exchange {
    const MIN_LEN: usize = 504;

    pub fn load(global_config: &AccountInfo) -> Result<Self> {
        require_keys_eq!(
            global_config.key(),
            PHOENIX_GLOBAL_CONFIG,
            VaultError::InvalidPhoenixAccount
        );
        check_phoenix_account(global_config, account::GLOBAL_CONFIGURATION, Self::MIN_LEN)?;
        let data = global_config.try_borrow_data()?;
        Ok(Self {
            canonical_mint: pk(&data, 296),
            global_vault: pk(&data, 328),
            perp_asset_map: pk(&data, 360),
            global_trader_index: pk(&data, 392),
            active_trader_buffer: pk(&data, 424),
            withdraw_queue: pk(&data, 472),
        })
    }

    /// Every trading, collateral and view instruction takes the dynamic tail
    /// `[GTI header, GTI arenas.., ATB header, ATB arenas..]`. Each header's arena count includes
    /// the header itself.
    pub fn check_tail(&self, tail: &[AccountInfo]) -> Result<()> {
        let gti = arena_count(
            tail.first(),
            self.global_trader_index,
            account::GLOBAL_TRADER_INDEX,
        )?;
        let atb = arena_count(
            tail.get(gti),
            self.active_trader_buffer,
            account::ACTIVE_TRADER_BUFFER,
        )?;
        require!(tail.len() == gti + atb, VaultError::InvalidPhoenixTail);
        for info in tail {
            require_keys_eq!(
                *info.owner,
                PHOENIX_PROGRAM_ID,
                VaultError::InvalidPhoenixTail
            );
        }
        Ok(())
    }
}

fn arena_count(
    header: Option<&AccountInfo>,
    expected: Pubkey,
    discriminator: [u8; 8],
) -> Result<usize> {
    let header = header.ok_or(VaultError::InvalidPhoenixTail)?;
    require_keys_eq!(header.key(), expected, VaultError::InvalidPhoenixTail);
    check_phoenix_account(header, discriminator, 80)?;
    let data = header.try_borrow_data()?;
    let count = u16_at(&data, 52).min(u16_at(&data, 54)) as usize;
    require!(count > 0, VaultError::InvalidPhoenixTail);
    Ok(count)
}

/// Header of a Phoenix trader account.
#[derive(Clone, Copy, Debug)]
pub struct TraderHeader {
    pub authority: Pubkey,
    /// Deposited collateral plus realized PnL, quote lots (= USDC atoms).
    pub collateral: i64,
    pub flags: u32,
    /// Non-zero while a withdrawal of this trader waits in the exchange withdraw queue.
    pub withdraw_queue_node: u32,
}

/// Trader capability flags Phoenix sets when it onboards an account.
const CAN_PLACE_MARKET: u32 = 1 << 2;
const CAN_DEPOSIT: u32 = 1 << 4;
const CAN_WITHDRAW: u32 = 1 << 5;

impl TraderHeader {
    /// Phoenix has enabled market orders, deposits and withdrawals for this trader.
    pub fn is_onboarded(&self) -> bool {
        let ready = CAN_PLACE_MARKET | CAN_DEPOSIT | CAN_WITHDRAW;
        self.flags & ready == ready
    }

    pub fn load(trader_account: &AccountInfo) -> Result<Self> {
        check_phoenix_account(trader_account, account::TRADER, 240)?;
        let data = trader_account.try_borrow_data()?;
        Ok(Self {
            authority: pk(&data, 56),
            collateral: i64_at(&data, 88),
            flags: u32_at(&data, 96),
            withdraw_queue_node: u32_at(&data, 108),
        })
    }
}

/// Fill summary Phoenix returns from an order instruction.
#[derive(Clone, Copy, Debug, Default)]
pub struct Fill {
    pub base_lots: u64,
    pub quote_lots: u64,
}

/// The launch's Phoenix account at current mark.
///
/// Collateral comes from the trader account header; position, PnL, funding, mark and margin come
/// from one Hawkeye `view_margin_for_asset` call. A launch only ever trades its one market, so
/// that asset is the whole account. One view instead of several matters on mainnet, where each
/// Hawkeye view costs a few hundred thousand compute units.
///
/// This view does not say how old the mark is; [Views::mark_updated_slot] does, and is called
/// wherever a stale mark could be exploited.
#[derive(Clone, Copy, Debug, Default)]
pub struct PerpView {
    /// Deposited collateral plus realized PnL, quote lots (= USDC atoms).
    pub collateral: i64,
    pub unrealized_pnl: i64,
    /// Positive is owed to the trader.
    pub unsettled_funding: i64,
    pub maintenance_margin: u64,
    /// Signed position in the launch's market; positive is long.
    pub base_lots: i64,
    /// `|base_lots| * mark`, quote lots.
    pub notional: u64,
    pub mark_price_ticks: u64,
}

impl PerpView {
    /// What the account would be worth if closed at mark: collateral + PnL + funding.
    pub fn equity(&self) -> i64 {
        self.collateral
            .saturating_add(self.unrealized_pnl)
            .saturating_add(self.unsettled_funding)
    }

    pub fn leverage_bps(&self) -> u64 {
        crate::math::leverage_bps(self.notional, self.equity())
    }

    /// Equity below the maintenance margin of the open position.
    pub fn is_liquidatable(&self) -> bool {
        self.notional > 0 && self.equity() < self.maintenance_margin as i64
    }
}

/// Accounts of the read-only Hawkeye views.
pub struct Views<'a, 'info> {
    pub hawkeye_program: &'a AccountInfo<'info>,
    pub phoenix_program: &'a AccountInfo<'info>,
    pub global_config: &'a AccountInfo<'info>,
    pub perp_asset_map: &'a AccountInfo<'info>,
    pub trader_account: &'a AccountInfo<'info>,
    pub orderbook: &'a AccountInfo<'info>,
    pub spline: &'a AccountInfo<'info>,
    pub tail: &'a [AccountInfo<'info>],
}

impl<'a, 'info> Views<'a, 'info> {
    /// Invokes a Hawkeye view over `[phoenix, global_config, tail.., perp_asset_map, extra..]`.
    fn call(&self, extra: &[&AccountInfo<'info>], data: Vec<u8>) -> Result<Vec<u8>> {
        let mut metas = vec![
            AccountMeta::new_readonly(self.phoenix_program.key(), false),
            AccountMeta::new_readonly(self.global_config.key(), false),
        ];
        let mut infos = vec![
            self.hawkeye_program.clone(),
            self.phoenix_program.clone(),
            self.global_config.clone(),
        ];
        for info in self
            .tail
            .iter()
            .chain([self.perp_asset_map])
            .chain(extra.iter().copied())
        {
            metas.push(AccountMeta::new_readonly(info.key(), false));
            infos.push(info.clone());
        }
        invoke(
            &Instruction {
                program_id: HAWKEYE_PROGRAM_ID,
                accounts: metas,
                data,
            },
            &infos,
        )?;
        let (program_id, out) = get_return_data().ok_or(VaultError::InvalidPhoenixReturnData)?;
        require!(
            program_id == HAWKEYE_PROGRAM_ID,
            VaultError::InvalidPhoenixReturnData
        );
        Ok(out)
    }

    /// Slot at which the market's mark price was last updated.
    pub fn mark_updated_slot(&self) -> Result<u64> {
        let out = self.call(&[self.orderbook, self.spline], ix::VIEW_BBO.to_vec())?;
        require!(
            out.len() == ret::BBO_LEN && out[..8] == ret::BBO && u16_at(&out, 8) == ret::VERSION,
            VaultError::InvalidPhoenixReturnData
        );
        Ok(u64_at(&out, 48))
    }

    pub fn load(&self, asset_id: u32) -> Result<PerpView> {
        let collateral = TraderHeader::load(self.trader_account)?.collateral;

        let mut data = ix::VIEW_MARGIN_FOR_ASSET.to_vec();
        data.extend_from_slice(&asset_id.to_le_bytes());
        data.extend_from_slice(&[0; 4]);
        let out = self.call(&[self.trader_account], data)?;
        require!(
            out.len() == ret::ASSET_LEN
                && out[..8] == ret::ASSET
                && u32_at(&out, 8) == asset_id
                && u16_at(&out, 12) == ret::VERSION,
            VaultError::InvalidPhoenixReturnData
        );
        Ok(PerpView {
            collateral,
            unrealized_pnl: i64_at(&out, 64),
            unsettled_funding: i64_at(&out, 80),
            maintenance_margin: u64_at(&out, 96),
            base_lots: i64_at(&out, 24),
            notional: i64_at(&out, 56).unsigned_abs(),
            mark_price_ticks: u64_at(&out, 40),
        })
    }
}

/// Accounts of the signed Phoenix instructions issued for `trader`, the launch PDA.
pub struct Phoenix<'a, 'info> {
    pub phoenix_program: &'a AccountInfo<'info>,
    pub log_authority: &'a AccountInfo<'info>,
    pub global_config: &'a AccountInfo<'info>,
    pub trader: &'a AccountInfo<'info>,
    pub trader_account: &'a AccountInfo<'info>,
    pub tail: &'a [AccountInfo<'info>],
}

impl<'a, 'info> Phoenix<'a, 'info> {
    /// `[phoenix_program, log_authority, global_config (mut), trader (signer)]`
    fn prefix(&self) -> (Vec<AccountMeta>, Vec<AccountInfo<'info>>) {
        (
            vec![
                AccountMeta::new_readonly(self.phoenix_program.key(), false),
                AccountMeta::new_readonly(self.log_authority.key(), false),
                AccountMeta::new(self.global_config.key(), false),
                AccountMeta::new_readonly(self.trader.key(), true),
            ],
            vec![
                self.phoenix_program.clone(),
                self.log_authority.clone(),
                self.global_config.clone(),
                self.trader.clone(),
            ],
        )
    }

    fn push(
        metas: &mut Vec<AccountMeta>,
        infos: &mut Vec<AccountInfo<'info>>,
        info: &AccountInfo<'info>,
        writable: bool,
    ) {
        metas.push(if writable {
            AccountMeta::new(info.key(), false)
        } else {
            AccountMeta::new_readonly(info.key(), false)
        });
        infos.push(info.clone());
    }

    fn push_tail(&self, metas: &mut Vec<AccountMeta>, infos: &mut Vec<AccountInfo<'info>>) {
        for info in self.tail {
            Self::push(metas, infos, info, true);
        }
    }

    fn send(
        &self,
        metas: Vec<AccountMeta>,
        infos: Vec<AccountInfo<'info>>,
        data: Vec<u8>,
        seeds: &[&[u8]],
    ) -> Result<()> {
        invoke_signed(
            &Instruction {
                program_id: PHOENIX_PROGRAM_ID,
                accounts: metas,
                data,
            },
            &infos,
            &[seeds],
        )?;
        Ok(())
    }

    /// Creates the trader account. Phoenix only reads `trader`; `payer` funds the account. A new
    /// trader has no capabilities until Phoenix's onboarding enables them.
    pub fn register_trader(
        &self,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
    ) -> Result<()> {
        let mut data = ix::REGISTER_TRADER.to_vec();
        data.extend_from_slice(&TRADER_MAX_POSITIONS.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes()); // trader_preference_bits
        data.push(TRADER_PDA_INDEX);
        data.push(TRADER_SUBACCOUNT_INDEX);

        invoke(
            &Instruction {
                program_id: PHOENIX_PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new_readonly(self.phoenix_program.key(), false),
                    AccountMeta::new_readonly(self.log_authority.key(), false),
                    AccountMeta::new_readonly(self.global_config.key(), false),
                    AccountMeta::new(payer.key(), true),
                    AccountMeta::new_readonly(self.trader.key(), false),
                    AccountMeta::new(self.trader_account.key(), false),
                    AccountMeta::new_readonly(system_program.key(), false),
                ],
                data,
            },
            &[
                self.phoenix_program.clone(),
                self.log_authority.clone(),
                self.global_config.clone(),
                payer.clone(),
                self.trader.clone(),
                self.trader_account.clone(),
                system_program.clone(),
            ],
        )?;
        Ok(())
    }

    pub fn deposit(
        &self,
        trader_canonical: &AccountInfo<'info>,
        global_vault: &AccountInfo<'info>,
        token_program: &AccountInfo<'info>,
        amount: u64,
        seeds: &[&[u8]],
    ) -> Result<()> {
        let (mut metas, mut infos) = self.prefix();
        Self::push(&mut metas, &mut infos, trader_canonical, true);
        Self::push(&mut metas, &mut infos, self.trader_account, true);
        Self::push(&mut metas, &mut infos, global_vault, true);
        Self::push(&mut metas, &mut infos, token_program, false);
        self.push_tail(&mut metas, &mut infos);

        let mut data = ix::DEPOSIT_FUNDS.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        self.send(metas, infos, data, seeds)
    }

    /// Pays `amount` of canonical tokens into `trader_canonical` now, or queues it behind the
    /// exchange-wide withdraw budget.
    #[allow(clippy::too_many_arguments)]
    pub fn withdraw(
        &self,
        perp_asset_map: &AccountInfo<'info>,
        global_vault: &AccountInfo<'info>,
        trader_canonical: &AccountInfo<'info>,
        token_program: &AccountInfo<'info>,
        withdraw_queue: &AccountInfo<'info>,
        amount: u64,
        seeds: &[&[u8]],
    ) -> Result<()> {
        let (mut metas, mut infos) = self.prefix();
        Self::push(&mut metas, &mut infos, self.trader_account, true);
        Self::push(&mut metas, &mut infos, perp_asset_map, true);
        Self::push(&mut metas, &mut infos, global_vault, true);
        Self::push(&mut metas, &mut infos, trader_canonical, true);
        Self::push(&mut metas, &mut infos, token_program, false);
        self.push_tail(&mut metas, &mut infos);
        Self::push(&mut metas, &mut infos, withdraw_queue, true);

        let mut data = ix::WITHDRAW_FUNDS.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        self.send(metas, infos, data, seeds)
    }

    /// Immediate-or-cancel order. Whatever does not fill at `limit_price_ticks` or better is
    /// cancelled, so a partial fill leaves nothing resting on the book.
    #[allow(clippy::too_many_arguments)]
    pub fn place_ioc(
        &self,
        perp_asset_map: &AccountInfo<'info>,
        orderbook: &AccountInfo<'info>,
        spline: &AccountInfo<'info>,
        is_buy: bool,
        base_lots: u64,
        limit_price_ticks: u64,
        reduce_only: bool,
        seeds: &[&[u8]],
    ) -> Result<Fill> {
        let (mut metas, mut infos) = self.prefix();
        Self::push(&mut metas, &mut infos, self.trader_account, true);
        Self::push(&mut metas, &mut infos, perp_asset_map, true);
        self.push_tail(&mut metas, &mut infos);
        Self::push(&mut metas, &mut infos, orderbook, true);
        Self::push(&mut metas, &mut infos, spline, true);

        let mut data = ix::PLACE_MARKET_ORDER.to_vec();
        data.push(ORDER_PACKET_IOC);
        data.push(if is_buy { SIDE_BID } else { SIDE_ASK });
        data.push(1); // price_in_ticks: Some
        data.extend_from_slice(&limit_price_ticks.to_le_bytes());
        data.extend_from_slice(&base_lots.to_le_bytes());
        data.push(0); // num_quote_lots: None
        data.extend_from_slice(&0u64.to_le_bytes()); // min_base_lots_to_fill
        data.extend_from_slice(&0u64.to_le_bytes()); // min_quote_lots_to_fill
        data.push(SELF_TRADE_CANCEL_PROVIDE);
        data.push(0); // match_limit: None
        data.extend_from_slice(&0u128.to_le_bytes()); // client_order_id
        data.push(0); // last_valid_slot: None
        data.push(if reduce_only {
            ORDER_FLAG_REDUCE_ONLY
        } else {
            0
        });
        data.push(0); // cancel_existing
        self.send(metas, infos, data, seeds)?;

        let (program_id, out) = get_return_data().ok_or(VaultError::InvalidPhoenixReturnData)?;
        require!(
            program_id == PHOENIX_PROGRAM_ID && out.len() == ret::MATCHING_LEN,
            VaultError::InvalidPhoenixReturnData
        );
        // only one of each in/out pair is non-zero, depending on the side
        Ok(Fill {
            quote_lots: u64_at(&out, 16).saturating_add(u64_at(&out, 32)),
            base_lots: u64_at(&out, 24).saturating_add(u64_at(&out, 40)),
        })
    }
}

/// Ember wraps USDC 1:1 into the Phoenix canonical token and back, for `trader`.
pub struct Ember<'a, 'info> {
    pub ember_program: &'a AccountInfo<'info>,
    pub trader: &'a AccountInfo<'info>,
    pub ember_state: &'a AccountInfo<'info>,
    pub usdc_mint: &'a AccountInfo<'info>,
    pub canonical_mint: &'a AccountInfo<'info>,
    pub trader_usdc: &'a AccountInfo<'info>,
    pub trader_canonical: &'a AccountInfo<'info>,
    pub ember_vault: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
}

impl<'a, 'info> Ember<'a, 'info> {
    pub fn deposit(&self, amount: u64, seeds: &[&[u8]]) -> Result<()> {
        let mut data = ix::EMBER_DEPOSIT.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        self.send(data, seeds)
    }

    /// Unwraps the whole canonical balance.
    pub fn withdraw_all(&self, seeds: &[&[u8]]) -> Result<()> {
        let mut data = ix::EMBER_WITHDRAW.to_vec();
        data.push(0); // amount: None
        self.send(data, seeds)
    }

    fn send(&self, data: Vec<u8>, seeds: &[&[u8]]) -> Result<()> {
        invoke_signed(
            &Instruction {
                program_id: EMBER_PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new_readonly(self.trader.key(), true),
                    AccountMeta::new_readonly(self.ember_state.key(), false),
                    AccountMeta::new_readonly(self.usdc_mint.key(), false),
                    AccountMeta::new(self.canonical_mint.key(), false),
                    AccountMeta::new(self.trader_usdc.key(), false),
                    AccountMeta::new(self.trader_canonical.key(), false),
                    AccountMeta::new(self.ember_vault.key(), false),
                    AccountMeta::new_readonly(self.token_program.key(), false),
                ],
                data,
            },
            &[
                self.ember_program.clone(),
                self.trader.clone(),
                self.ember_state.clone(),
                self.usdc_mint.clone(),
                self.canonical_mint.clone(),
                self.trader_usdc.clone(),
                self.trader_canonical.clone(),
                self.ember_vault.clone(),
                self.token_program.clone(),
            ],
            &[seeds],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    fn sighash(preimage: &str) -> [u8; 8] {
        Sha256::digest(preimage.as_bytes())[..8].try_into().unwrap()
    }

    #[test]
    fn discriminators_match_their_preimages() {
        for (value, preimage) in [
            (ix::REGISTER_TRADER, "global:register_trader"),
            (ix::DEPOSIT_FUNDS, "global:deposit_funds"),
            (ix::WITHDRAW_FUNDS, "global:withdraw_funds"),
            (ix::PLACE_MARKET_ORDER, "global:place_market_order"),
            (ix::EMBER_DEPOSIT, "global:deposit"),
            (ix::EMBER_WITHDRAW, "global:withdraw"),
            (ix::VIEW_MARGIN_FOR_ASSET, "global:view_margin_for_asset"),
            (ix::VIEW_BBO, "global:view_bbo"),
            (
                account::GLOBAL_CONFIGURATION,
                "account:global_configuration",
            ),
            (account::TRADER, "account:trader"),
            (account::GLOBAL_TRADER_INDEX, "account:global_trader_index"),
            (
                account::ACTIVE_TRADER_BUFFER,
                "account:active_trader_buffer",
            ),
            (ret::ASSET, "return:phoenix_hawkeye_asset"),
            (ret::BBO, "return:phoenix_hawkeye_bbo"),
        ] {
            assert_eq!(value, sighash(preimage), "{preimage}");
        }
    }

    #[test]
    fn fixed_addresses_are_the_expected_pdas() {
        let ember = |seed: &[u8]| {
            Pubkey::find_program_address(&[PHOENIX_PROGRAM_ID.as_ref(), seed], &EMBER_PROGRAM_ID).0
        };
        assert_eq!(ember(b"state"), EMBER_STATE);
        assert_eq!(ember(b"vault"), EMBER_VAULT);
        assert_eq!(
            Pubkey::find_program_address(&[b"log"], &PHOENIX_PROGRAM_ID).0,
            PHOENIX_LOG_AUTHORITY
        );
        assert_eq!(
            Pubkey::find_program_address(&[b"global"], &PHOENIX_PROGRAM_ID).0,
            PHOENIX_GLOBAL_CONFIG
        );
    }
}
