//! LiteSVM harness for `terp`.
//!
//! What is real and what is mocked:
//!
//! - Phoenix perps, Ember and Hawkeye are the **deployed mainnet binaries**, fetched and cached by
//!   the Rise SDK fixture (`PHOENIX_MAINNET_BPF_PROGRAMS=1`) and initialised at their mainnet
//!   addresses with local markets, oracle and maker liquidity.
//! - Token-2022 and SPL Token are the real programs bundled with LiteSVM.
//! - USDC is the fixture's test mint, moved to the mainnet USDC address so the program's pinned
//!   `USDC_MINT` holds.
//! - The AMM is **MOCK** (`programs/mock-swap`), standing in for Meteora DLMM.
//! - Phoenix onboarding (capability flags, normally granted by Phoenix's API) is simulated by
//!   copying the flags of a fixture trader.
mod scenario;
pub use scenario::LOT_USDC;

use std::path::PathBuf;

use anchor_lang::{
    AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use base64::{engine::general_purpose::STANDARD, Engine};
pub use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use phoenix_rise_litesvm_test::{
    default_sdk_localnet_fixture, find_sdk_localnet_program_paths, parse_pubkey,
    SdkLocalnetContext, SdkLocalnetProgram,
};
use sha2::{Digest, Sha256};
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
pub use solana_pubkey::Pubkey;
use solana_transaction_error::TransactionError;
use spl_token_2022_interface::{
    extension::{transfer_fee::instruction as fee_ix, ExtensionType},
    instruction as token_ix,
    state::Mint,
};
pub use terp::{
    error::VaultError,
    events::*,
    math,
    phoenix::{
        EMBER_PROGRAM_ID, EMBER_STATE, EMBER_VAULT, HAWKEYE_PROGRAM_ID, PHOENIX_GLOBAL_CONFIG,
        PHOENIX_LOG_AUTHORITY, PHOENIX_PROGRAM_ID,
    },
    AddMarketArgs, Claim, CreateLaunchArgs, InitConfigArgs, Launch, Market, ProtocolConfig,
    UpdateConfigArgs, USDC_MINT,
};

pub const USDC: u64 = 1_000_000;
/// Launched tokens use 6 decimals in tests.
pub const TOKEN: u64 = 1_000_000;
pub const DECIMALS: u8 = 6;
/// The fixture lists BTC, ETH, SOL; asset ids follow that order.
pub const SOL_ASSET_ID: u32 = 2;
pub const BTC_ASSET_ID: u32 = 0;
/// Quote lots per base lot per tick of the fixture's BTC market.
pub const BTC_TICK_SIZE: u64 = 100;
pub const SOL_PRICE: f64 = 150.0;

pub const TOKEN_PROGRAM: Pubkey =
    Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey =
    Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");
const COMPUTE_BUDGET_PROGRAM: Pubkey =
    Pubkey::from_str_const("ComputeBudget111111111111111111111111111111");

pub const ADMIN: &str = "tv-admin";
/// Nobody special: any funded wallet, for the instructions anyone may send.
pub const CALLER: &str = "tv-caller";
/// The launchpad operator's key: the only one that may convert tax and deploy it.
pub const KEEPER: &str = "tv-keeper";
/// The platform's share of converted tax: 3%.
pub const KEEPER_FEE_BPS: u16 = 300;

/// The keeper fee on `usdc_out` of converted tax, as the program computes it.
pub fn keeper_fee(usdc_out: u64) -> u64 {
    (usdc_out as u128 * KEEPER_FEE_BPS as u128 / 10_000) as u64
}
pub const TREASURY: &str = "tv-treasury";
pub const CREATOR: &str = "tv-creator";

const TRADER_FLAGS_OFFSET: usize = 96;

fn deploy_dir() -> PathBuf {
    std::env::var("TERP_DEPLOY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy")))
}

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    pda(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
}

pub fn config_pda() -> Pubkey {
    pda(&[b"config"], &terp::ID)
}

pub fn sighash(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}

pub fn ix(
    program: Pubkey,
    accounts: impl ToAccountMetas,
    data: impl InstructionData,
) -> Instruction {
    Instruction {
        program_id: program,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

fn create_ata_ix(
    payer: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint, token_program), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1], // CreateIdempotent
    }
}

/// Asserts that a transaction failed with the given program error.
pub fn assert_err(
    result: Result<TransactionMetadata, FailedTransactionMetadata>,
    error: VaultError,
) {
    let failed = result.expect_err("transaction should have failed");
    let code: u32 = error.into();
    match failed.err {
        TransactionError::InstructionError(_, InstructionError::Custom(actual))
            if actual == code => {}
        other => panic!(
            "expected {code}, got {other:?}\n{}",
            failed.meta.logs.join("\n")
        ),
    }
}

pub fn ok(result: Result<TransactionMetadata, FailedTransactionMetadata>) -> TransactionMetadata {
    result.unwrap_or_else(|failed| panic!("{:?}\n{}", failed.err, failed.meta.logs.join("\n")))
}

pub fn events<T: AnchorDeserialize + Discriminator>(meta: &TransactionMetadata) -> Vec<T> {
    meta.logs
        .iter()
        .filter_map(|log| log.strip_prefix("Program data: "))
        .filter_map(|data| STANDARD.decode(data).ok())
        .filter(|bytes| bytes.starts_with(T::DISCRIMINATOR))
        .map(|bytes| T::deserialize(&mut &bytes[T::DISCRIMINATOR.len()..]).unwrap())
        .collect()
}

pub fn event<T: AnchorDeserialize + Discriminator>(meta: &TransactionMetadata) -> T {
    let mut found = events::<T>(meta);
    assert_eq!(
        found.len(),
        1,
        "expected one event\n{}",
        meta.logs.join("\n")
    );
    found.remove(0)
}

/// How a test mint deviates from a valid launch mint.
#[derive(Clone, Copy)]
pub struct MintOpts {
    pub supply: u64,
    pub fee_bps: u16,
    pub max_fee: u64,
    pub revoke_mint_authority: bool,
    pub fee_config_authority: bool,
    pub foreign_withheld_authority: bool,
    pub permanent_delegate: bool,
}

impl MintOpts {
    pub fn valid(supply: u64) -> Self {
        Self {
            supply,
            fee_bps: 300,
            max_fee: u64::MAX,
            revoke_mint_authority: true,
            fee_config_authority: false,
            foreign_withheld_authority: false,
            permanent_delegate: false,
        }
    }
}

/// Start price of the test pools (30,000 USDC against 485,000 tokens), scaled by 1e12.
pub const POOL_START_PRICE: u128 = 30_000 * 1_000_000_000_000 / 485_000;
/// Quote lots per base lot per tick of the fixture's SOL market.
pub const SOL_TICK_SIZE: u64 = 10;

pub fn default_args(supply: u64) -> CreateLaunchArgs {
    CreateLaunchArgs {
        total_supply: supply,
        creator_allocation: supply / 2,
        pool_allocation: supply - supply / 2,
        initial_price: POOL_START_PRICE,
        min_convert_tokens: 100 * TOKEN,
        max_convert_tokens: 50_000 * TOKEN,
        convert_cooldown_slots: 10,
        max_price_drop_bps: 1_000,
        min_deposit_usdc: 10 * USDC,
        min_redeem_tokens: TOKEN,
    }
}

/// Exchange-wide Phoenix accounts of the fixture.
#[derive(Clone)]
pub struct Exchange {
    pub canonical_mint: Pubkey,
    pub global_vault: Pubkey,
    pub perp_asset_map: Pubkey,
    pub withdraw_queue: Pubkey,
    pub tail: Vec<Pubkey>,
    pub orderbook: Pubkey,
    pub spline: Pubkey,
}

/// Addresses of one launch.
#[derive(Clone, Copy, Debug)]
pub struct LaunchKeys {
    pub mint: Pubkey,
    pub launch: Pubkey,
    pub tax_authority: Pubkey,
    pub tax_account: Pubkey,
    pub tax_usdc: Pubkey,
    pub vault_usdc: Pubkey,
    pub trader_account: Pubkey,
    pub canonical_account: Pubkey,
    pub pool: Pubkey,
    pub pool_token_vault: Pubkey,
    pub pool_usdc_vault: Pubkey,
    /// The launch's perp market; the fixture's SOL market unless a test says otherwise.
    pub orderbook: Pubkey,
    pub spline: Pubkey,
}

impl LaunchKeys {
    pub fn of(mint: Pubkey, canonical_mint: &Pubkey) -> Self {
        let launch = pda(&[b"launch", mint.as_ref()], &terp::ID);
        let tax_authority = pda(&[b"tax", launch.as_ref()], &terp::ID);
        let pool = pda(&[b"pool", mint.as_ref()], &mock_swap::ID);
        Self {
            mint,
            launch,
            tax_authority,
            tax_account: ata(&tax_authority, &mint, &TOKEN_2022_PROGRAM),
            tax_usdc: ata(&tax_authority, &USDC_MINT, &TOKEN_PROGRAM),
            vault_usdc: ata(&launch, &USDC_MINT, &TOKEN_PROGRAM),
            trader_account: pda(&[b"trader", launch.as_ref(), &[0, 0]], &PHOENIX_PROGRAM_ID),
            canonical_account: ata(&launch, canonical_mint, &TOKEN_PROGRAM),
            pool,
            pool_token_vault: ata(&pool, &mint, &TOKEN_2022_PROGRAM),
            pool_usdc_vault: ata(&pool, &USDC_MINT, &TOKEN_PROGRAM),
            orderbook: Pubkey::default(),
            spline: Pubkey::default(),
        }
    }
}

/// The launch's Phoenix account as Hawkeye reports it.
#[derive(Clone, Copy, Debug)]
pub struct Perp {
    pub collateral: i64,
    pub unrealized_pnl: i64,
    pub unsettled_funding: i64,
    pub is_liquidatable: bool,
    pub base_lots: i64,
    pub notional: u64,
}

impl Perp {
    pub fn equity(&self) -> i64 {
        self.collateral + self.unrealized_pnl + self.unsettled_funding
    }
    pub fn leverage_bps(&self) -> u64 {
        math::leverage_bps(self.notional, self.equity())
    }
}

pub struct Ctx {
    pub px: SdkLocalnetContext,
    pub exchange: Exchange,
    pub admin: Pubkey,
    pub caller: Pubkey,
    pub keeper: Pubkey,
    pub treasury: Pubkey,
    pub creator: Pubkey,
    mint_counter: u32,
}

impl Ctx {
    pub fn new() -> Self {
        let fixture = default_sdk_localnet_fixture().unwrap();
        let paths = find_sdk_localnet_program_paths()
            .expect("set PHOENIX_MAINNET_BPF_PROGRAMS=1 to load the Phoenix programs");
        let mut px = SdkLocalnetContext::new_with_programs(
            fixture,
            paths,
            [
                SdkLocalnetProgram::new(terp::ID, deploy_dir().join("terp.so")),
                SdkLocalnetProgram::new(mock_swap::ID, deploy_dir().join("mock_swap.so")),
            ],
        );
        px.execute_setup();

        let addresses = px.fixture.addresses.clone();
        assert_eq!(
            parse_pubkey(&addresses.global_config).unwrap(),
            PHOENIX_GLOBAL_CONFIG
        );
        assert_eq!(
            parse_pubkey(&addresses.log_authority).unwrap(),
            PHOENIX_LOG_AUTHORITY
        );
        let market = px.market("SOL");
        let exchange = Exchange {
            canonical_mint: px.phoenix_collateral_mint(),
            global_vault: parse_pubkey(&addresses.global_vault).unwrap(),
            perp_asset_map: parse_pubkey(&addresses.perp_asset_map).unwrap(),
            withdraw_queue: parse_pubkey(&addresses.withdraw_queue).unwrap(),
            tail: addresses
                .global_trader_index
                .iter()
                .chain(&addresses.active_trader_buffer)
                .map(|key| parse_pubkey(key).unwrap())
                .collect(),
            orderbook: parse_pubkey(&market.orderbook).unwrap(),
            spline: parse_pubkey(&market.spline).unwrap(),
        };

        let admin = px.add_signer(ADMIN, 1_000_000_000_000);
        let caller = px.add_signer(CALLER, 1_000_000_000_000);
        let keeper = px.add_signer(KEEPER, 1_000_000_000_000);
        let treasury = px.add_signer(TREASURY, 1_000_000_000);
        let creator = px.add_signer(CREATOR, 1_000_000_000_000);
        let mut ctx = Self {
            px,
            exchange,
            admin,
            caller,
            keeper,
            treasury,
            creator,
            mint_counter: 0,
        };
        ctx.use_mainnet_usdc();
        ok(ctx.send(
            TREASURY,
            vec![create_ata_ix(
                &treasury,
                &treasury,
                &USDC_MINT,
                &TOKEN_PROGRAM,
            )],
        ));
        ok(ctx.send(
            CALLER,
            vec![create_ata_ix(&caller, &caller, &USDC_MINT, &TOKEN_PROGRAM)],
        ));
        ok(ctx.send(
            ADMIN,
            vec![ix(
                terp::ID,
                terp::accounts::InitConfig {
                    admin,
                    config: config_pda(),
                    system_program: SYSTEM_PROGRAM,
                },
                terp::instruction::InitConfig {
                    args: InitConfigArgs {
                        keeper,
                        treasury,
                        keeper_fee_bps: KEEPER_FEE_BPS,
                        swap_program: mock_swap::ID,
                        swap_discriminators: vec![sighash("swap"), sighash("swap_and_keep")],
                    },
                },
            )],
        ));
        // the leveraged assets launches may choose: the fixture's SOL and BTC perps
        ok(ctx.add_market(ADMIN, "SOL", SOL_ASSET_ID, SOL_TICK_SIZE, 2));
        ok(ctx.add_market(ADMIN, "BTC", BTC_ASSET_ID, BTC_TICK_SIZE, 4));
        ctx
    }

    pub fn market_pda(asset_id: u32) -> Pubkey {
        pda(&[b"market", &asset_id.to_le_bytes()], &terp::ID)
    }

    /// Admin lists one of the fixture's perp markets as a leveraged asset.
    pub fn add_market(
        &mut self,
        signer: &str,
        symbol: &str,
        asset_id: u32,
        tick_size: u64,
        base_lot_decimals: u8,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let fixture = self.px.market(symbol);
        let mut name = [0u8; 16];
        name[..symbol.len()].copy_from_slice(symbol.as_bytes());
        self.send(
            signer,
            vec![ix(
                terp::ID,
                terp::accounts::AddMarket {
                    admin: self.px.signer_pubkey(signer),
                    config: config_pda(),
                    market: Self::market_pda(asset_id),
                    orderbook: parse_pubkey(&fixture.orderbook).unwrap(),
                    spline: parse_pubkey(&fixture.spline).unwrap(),
                    system_program: SYSTEM_PROGRAM,
                },
                terp::instruction::AddMarket {
                    args: AddMarketArgs {
                        asset_id,
                        tick_size,
                        base_lot_decimals,
                        symbol: name,
                    },
                },
            )],
        )
    }

    pub fn market(&self, asset_id: u32) -> Market {
        Market::try_deserialize(&mut self.px.account_data(&Self::market_pda(asset_id)).as_slice())
            .unwrap()
    }

    /// Moves the fixture's test USDC mint to the mainnet USDC address and repoints Ember at it.
    fn use_mainnet_usdc(&mut self) {
        let fake = self.px.fake_usdc_mint();
        let mint = self.px.svm.get_account(&fake).unwrap();
        self.px.svm.set_account(USDC_MINT, mint).unwrap();
        for address in [EMBER_STATE, EMBER_VAULT] {
            let mut account = self.px.svm.get_account(&address).unwrap();
            let mut replaced = 0;
            let mut at = 0;
            while at + 32 <= account.data.len() {
                if account.data[at..at + 32] == fake.to_bytes() {
                    account.data[at..at + 32].copy_from_slice(&USDC_MINT.to_bytes());
                    replaced += 1;
                    at += 32;
                } else {
                    at += 1;
                }
            }
            assert!(
                replaced > 0,
                "{address} does not reference the test USDC mint"
            );
            self.px.svm.set_account(address, account).unwrap();
        }
    }

    pub fn send(
        &mut self,
        payer: &str,
        instructions: Vec<Instruction>,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let mut budget = vec![2];
        budget.extend_from_slice(&1_400_000u32.to_le_bytes());
        let mut all = vec![Instruction {
            program_id: COMPUTE_BUDGET_PROGRAM,
            accounts: vec![],
            data: budget,
        }];
        all.extend(instructions);
        self.px.try_send_instructions_with_metadata(all, payer)
    }

    // Chain state

    pub fn slot(&self) -> u64 {
        self.px.svm.get_sysvar::<solana_clock::Clock>().slot
    }

    pub fn warp(&mut self, slots: u64) {
        let slot = self.slot();
        self.px.svm.warp_to_slot(slot + slots);
    }

    /// Moves SOL mark, spot and spline to `price_usd`, which also refreshes the mark slot.
    pub fn set_sol_price(&mut self, price_usd: f64) {
        self.px.move_market_price_usd("SOL", price_usd);
    }

    pub fn sol_ticks(&self, price_usd: f64) -> u64 {
        self.px.market("SOL").price_usd_to_ticks(price_usd, 6)
    }

    pub fn balance(&self, token_account: &Pubkey) -> u64 {
        match self.px.svm.get_account(token_account) {
            Some(account) if account.data.len() >= 72 => {
                u64::from_le_bytes(account.data[64..72].try_into().unwrap())
            }
            _ => 0,
        }
    }

    pub fn supply(&self, mint: &Pubkey) -> u64 {
        let data = self.px.account_data(mint);
        u64::from_le_bytes(data[36..44].try_into().unwrap())
    }

    pub fn exists(&self, address: &Pubkey) -> bool {
        self.px
            .svm
            .get_account(address)
            .is_some_and(|a| a.lamports > 0)
    }

    pub fn launch(&self, keys: &LaunchKeys) -> Launch {
        Launch::try_deserialize(&mut self.px.account_data(&keys.launch).as_slice()).unwrap()
    }

    /// What a redeemer is still owed after Phoenix queued their withdrawal.
    pub fn claim(&self, keys: &LaunchKeys, owner: &Pubkey) -> Option<Claim> {
        let account = self.px.svm.get_account(&self.claim_pda(keys, owner))?;
        if account.lamports == 0 {
            return None;
        }
        Claim::try_deserialize(&mut account.data.as_slice()).ok()
    }

    pub fn claim_pda(&self, keys: &LaunchKeys, owner: &Pubkey) -> Pubkey {
        pda(&[b"claim", keys.launch.as_ref(), owner.as_ref()], &terp::ID)
    }

    /// Reads the launch's Phoenix account through Hawkeye, independently of the program.
    pub fn perp(&mut self, keys: &LaunchKeys) -> Perp {
        let mut accounts = vec![
            AccountMeta::new_readonly(PHOENIX_PROGRAM_ID, false),
            AccountMeta::new_readonly(PHOENIX_GLOBAL_CONFIG, false),
        ];
        accounts.extend(
            self.exchange
                .tail
                .iter()
                .map(|k| AccountMeta::new_readonly(*k, false)),
        );
        accounts.push(AccountMeta::new_readonly(
            self.exchange.perp_asset_map,
            false,
        ));
        accounts.push(AccountMeta::new_readonly(keys.trader_account, false));

        let margin = ok(self.send(
            "payer",
            vec![Instruction {
                program_id: HAWKEYE_PROGRAM_ID,
                accounts: accounts.clone(),
                data: sighash("view_margin").to_vec(),
            }],
        ))
        .return_data
        .data;
        let mut data = sighash("view_margin_for_asset").to_vec();
        data.extend_from_slice(&SOL_ASSET_ID.to_le_bytes());
        data.extend_from_slice(&[0; 4]);
        let asset = ok(self.send(
            "payer",
            vec![Instruction {
                program_id: HAWKEYE_PROGRAM_ID,
                accounts,
                data,
            }],
        ))
        .return_data
        .data;
        let i64_at = |d: &[u8], at: usize| i64::from_le_bytes(d[at..at + 8].try_into().unwrap());
        Perp {
            collateral: i64_at(&margin, 16),
            unrealized_pnl: i64_at(&margin, 88),
            unsettled_funding: i64_at(&margin, 104),
            is_liquidatable: margin[14] != 0,
            base_lots: i64_at(&asset, 24),
            notional: i64_at(&asset, 56).unsigned_abs(),
        }
    }

    /// `E` as the program defines it, computed here from raw balances and Hawkeye: assets less
    /// what is owed to claims.
    pub fn equity(&mut self, keys: &LaunchKeys) -> u64 {
        let claims = self.launch(keys).pending_claims;
        self.assets(keys).saturating_sub(claims)
    }

    pub fn assets(&mut self, keys: &LaunchKeys) -> u64 {
        let idle = self.balance(&keys.vault_usdc);
        let canonical = self.balance(&keys.canonical_account);
        let phoenix = if self.exists(&keys.trader_account) {
            self.perp(keys).equity()
        } else {
            0
        };
        math::vault_equity(idle, canonical, phoenix).unwrap()
    }

    // Tokens

    pub fn mint_usdc(&mut self, token_account: &Pubkey, amount: u64) {
        let payer = self.px.signer_pubkey("payer");
        let mut data = vec![7];
        data.extend_from_slice(&amount.to_le_bytes());
        self.px.send_instructions(
            vec![Instruction {
                program_id: TOKEN_PROGRAM,
                accounts: vec![
                    AccountMeta::new(USDC_MINT, false),
                    AccountMeta::new(*token_account, false),
                    AccountMeta::new_readonly(payer, true),
                ],
                data,
            }],
            "payer",
            "mint-usdc",
        );
    }

    /// A funded wallet with token and USDC accounts for `mint`.
    pub fn user(&mut self, seed: &str, mint: &Pubkey) -> Pubkey {
        let user = self.px.add_signer(seed, 10_000_000_000);
        ok(self.send(
            seed,
            vec![
                create_ata_ix(&user, &user, mint, &TOKEN_2022_PROGRAM),
                create_ata_ix(&user, &user, &USDC_MINT, &TOKEN_PROGRAM),
            ],
        ));
        user
    }

    pub fn token_ata(&self, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        ata(owner, mint, &TOKEN_2022_PROGRAM)
    }

    pub fn usdc_ata(&self, owner: &Pubkey) -> Pubkey {
        ata(owner, &USDC_MINT, &TOKEN_PROGRAM)
    }

    /// A plain Token-2022 transfer, on which the mint's 3% fee is withheld at the recipient.
    pub fn transfer(
        &mut self,
        from_seed: &str,
        mint: &Pubkey,
        to_token_account: &Pubkey,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let from = self.px.signer_pubkey(from_seed);
        let transfer = token_ix::transfer_checked(
            &TOKEN_2022_PROGRAM,
            &self.token_ata(&from, mint),
            mint,
            to_token_account,
            &from,
            &[],
            amount,
            DECIMALS,
        )
        .unwrap();
        self.send(from_seed, vec![transfer])
    }

    /// Creates a Token-2022 mint with a transfer fee and mints the whole supply to the creator.
    pub fn create_mint(&mut self, opts: MintOpts) -> Pubkey {
        self.mint_counter += 1;
        let seed = format!("tv-mint-{}", self.mint_counter);
        let mint = self.px.add_signer(&seed, 0);
        let creator = self.creator;
        let launch = pda(&[b"launch", mint.as_ref()], &terp::ID);

        let mut extensions = vec![ExtensionType::TransferFeeConfig];
        if opts.permanent_delegate {
            extensions.push(ExtensionType::PermanentDelegate);
        }
        let space = ExtensionType::try_calculate_account_len::<Mint>(&extensions).unwrap();
        let lamports = self.px.svm.minimum_balance_for_rent_exemption(space);
        let mut create = 0u32.to_le_bytes().to_vec();
        create.extend_from_slice(&lamports.to_le_bytes());
        create.extend_from_slice(&(space as u64).to_le_bytes());
        create.extend_from_slice(TOKEN_2022_PROGRAM.as_ref());

        let withheld_authority = if opts.foreign_withheld_authority {
            creator
        } else {
            launch
        };
        let mut instructions = vec![
            Instruction {
                program_id: SYSTEM_PROGRAM,
                accounts: vec![
                    AccountMeta::new(creator, true),
                    AccountMeta::new(mint, true),
                ],
                data: create,
            },
            fee_ix::initialize_transfer_fee_config(
                &TOKEN_2022_PROGRAM,
                &mint,
                opts.fee_config_authority.then_some(&creator),
                Some(&withheld_authority),
                opts.fee_bps,
                opts.max_fee,
            )
            .unwrap(),
        ];
        if opts.permanent_delegate {
            instructions.push(
                token_ix::initialize_permanent_delegate(&TOKEN_2022_PROGRAM, &mint, &creator)
                    .unwrap(),
            );
        }
        instructions.extend([
            token_ix::initialize_mint2(&TOKEN_2022_PROGRAM, &mint, &creator, None, DECIMALS)
                .unwrap(),
            create_ata_ix(&creator, &creator, &mint, &TOKEN_2022_PROGRAM),
            create_ata_ix(&creator, &creator, &USDC_MINT, &TOKEN_PROGRAM),
            token_ix::mint_to(
                &TOKEN_2022_PROGRAM,
                &mint,
                &self.token_ata(&creator, &mint),
                &creator,
                &[],
                opts.supply,
            )
            .unwrap(),
        ]);
        if opts.revoke_mint_authority {
            instructions.push(
                token_ix::set_authority(
                    &TOKEN_2022_PROGRAM,
                    &mint,
                    None,
                    token_ix::AuthorityType::MintTokens,
                    &creator,
                    &[],
                )
                .unwrap(),
            );
        }
        ok(self.send(CREATOR, instructions));
        mint
    }

    // Launch lifecycle

    pub fn keys(&self, mint: Pubkey) -> LaunchKeys {
        self.keys_on(mint, SOL_ASSET_ID)
    }

    pub fn keys_on(&self, mint: Pubkey, asset_id: u32) -> LaunchKeys {
        let market = self.market(asset_id);
        LaunchKeys {
            orderbook: market.orderbook,
            spline: market.spline,
            ..LaunchKeys::of(mint, &self.exchange.canonical_mint)
        }
    }

    pub fn create_launch(
        &mut self,
        mint: Pubkey,
        args: CreateLaunchArgs,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.create_launch_on(mint, args, SOL_ASSET_ID)
    }

    /// Creates a launch whose tax is levered into the listed market `asset_id`.
    pub fn create_launch_on(
        &mut self,
        mint: Pubkey,
        args: CreateLaunchArgs,
        asset_id: u32,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let keys = self.keys(mint);
        self.send(
            CREATOR,
            vec![ix(
                terp::ID,
                terp::accounts::CreateLaunch {
                    creator: self.creator,
                    config: config_pda(),
                    market: Self::market_pda(asset_id),
                    mint,
                    launch: keys.launch,
                    tax_authority: keys.tax_authority,
                    tax_account: keys.tax_account,
                    usdc_mint: USDC_MINT,
                    vault_usdc: keys.vault_usdc,
                    tax_usdc: keys.tax_usdc,
                    token_program: TOKEN_PROGRAM,
                    token_2022_program: TOKEN_2022_PROGRAM,
                    associated_token_program: ATA_PROGRAM,
                    system_program: SYSTEM_PROGRAM,
                },
                terp::instruction::CreateLaunch { args },
            )],
        )
    }

    /// MOCK pool: seeds the stand-in AMM with `tokens` from the creator and `usdc`, and records it
    /// as the launch pool.
    pub fn create_pool(&mut self, keys: &LaunchKeys, tokens: u64, usdc: u64) {
        let creator = self.creator;
        ok(self.send(
            CREATOR,
            vec![
                create_ata_ix(&creator, &keys.pool, &keys.mint, &TOKEN_2022_PROGRAM),
                create_ata_ix(&creator, &keys.pool, &USDC_MINT, &TOKEN_PROGRAM),
                ix(
                    mock_swap::ID,
                    mock_swap::accounts::InitPool {
                        payer: creator,
                        pool: keys.pool,
                        token_mint: keys.mint,
                        token_vault: keys.pool_token_vault,
                        usdc_vault: keys.pool_usdc_vault,
                        system_program: SYSTEM_PROGRAM,
                    },
                    mock_swap::instruction::InitPool {},
                ),
                ix(
                    terp::ID,
                    terp::accounts::SetPool {
                        creator,
                        config: config_pda(),
                        launch: keys.launch,
                        pool: keys.pool,
                    },
                    terp::instruction::SetPool {},
                ),
            ],
        ));
        ok(self.transfer(CREATOR, &keys.mint, &keys.pool_token_vault, tokens));
        self.mint_usdc(&keys.pool_usdc_vault, usdc);
    }

    /// A valid launch with a pool: half the supply to the pool, half kept by the creator.
    pub fn launch_with_pool(&mut self, supply: u64, pool_usdc: u64) -> LaunchKeys {
        let mint = self.create_mint(MintOpts::valid(supply));
        ok(self.create_launch(mint, default_args(supply)));
        let keys = self.keys(mint);
        self.create_pool(&keys, supply / 2, pool_usdc);
        keys
    }

    pub fn register_trader(
        &mut self,
        keys: &LaunchKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.caller;
        self.send(
            CALLER,
            vec![ix(
                terp::ID,
                terp::accounts::RegisterTrader {
                    payer,
                    launch: keys.launch,
                    phoenix_program: PHOENIX_PROGRAM_ID,
                    log_authority: PHOENIX_LOG_AUTHORITY,
                    global_config: PHOENIX_GLOBAL_CONFIG,
                    trader_account: keys.trader_account,
                    canonical_mint: self.exchange.canonical_mint,
                    canonical_account: keys.canonical_account,
                    token_program: TOKEN_PROGRAM,
                    associated_token_program: ATA_PROGRAM,
                    system_program: SYSTEM_PROGRAM,
                },
                terp::instruction::RegisterTrader {},
            )],
        )
    }

    /// SIMULATED onboarding: Phoenix enables a trader's capabilities through its own onboarding
    /// flow. Here the capability flags of an onboarded fixture trader are copied over.
    pub fn onboard(&mut self, keys: &LaunchKeys) {
        let reference = self.px.account_data(&self.px.actor_trader("taker0"));
        let mut account = self.px.svm.get_account(&keys.trader_account).unwrap();
        account.data[TRADER_FLAGS_OFFSET..TRADER_FLAGS_OFFSET + 4]
            .copy_from_slice(&reference[TRADER_FLAGS_OFFSET..TRADER_FLAGS_OFFSET + 4]);
        self.px
            .svm
            .set_account(keys.trader_account, account)
            .unwrap();
    }

    /// Launch with pool and an onboarded Phoenix trader.
    pub fn ready_launch(&mut self, supply: u64, pool_usdc: u64) -> LaunchKeys {
        let keys = self.launch_with_pool(supply, pool_usdc);
        ok(self.register_trader(&keys));
        self.onboard(&keys);
        keys
    }

    // Tax

    pub fn collect_tax(
        &mut self,
        keys: &LaunchKeys,
        sources: &[Pubkey],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let mut collect = ix(
            terp::ID,
            terp::accounts::CollectTax {
                payer: self.caller,
                launch: keys.launch,
                mint: keys.mint,
                tax_account: keys.tax_account,
                token_2022_program: TOKEN_2022_PROGRAM,
            },
            terp::instruction::CollectTax {},
        );
        collect
            .accounts
            .extend(sources.iter().map(|k| AccountMeta::new(*k, false)));
        self.send(CALLER, vec![collect])
    }

    fn swap_accounts(&self, keys: &LaunchKeys) -> Vec<AccountMeta> {
        let mut metas = mock_swap::accounts::Swap {
            pool: keys.pool,
            user: keys.tax_authority,
            token_mint: keys.mint,
            usdc_mint: USDC_MINT,
            user_token: keys.tax_account,
            user_usdc: keys.tax_usdc,
            token_vault: keys.pool_token_vault,
            usdc_vault: keys.pool_usdc_vault,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
        }
        .to_account_metas(None);
        // the tax authority is a PDA: it signs inside the program, not the transaction
        for meta in &mut metas {
            meta.is_signer = false;
        }
        metas
    }

    fn convert_ix(
        &self,
        signer: &str,
        keys: &LaunchKeys,
        tokens_in: u64,
        swap_data: Vec<u8>,
    ) -> Instruction {
        let mut convert = ix(
            terp::ID,
            terp::accounts::ConvertTax {
                keeper: self.px.signer_pubkey(signer),
                config: config_pda(),
                launch: keys.launch,
                tax_authority: keys.tax_authority,
                tax_account: keys.tax_account,
                tax_usdc: keys.tax_usdc,
                vault_usdc: keys.vault_usdc,
                treasury_usdc: self.usdc_ata(&self.treasury),
                usdc_mint: USDC_MINT,
                token_program: TOKEN_PROGRAM,
                swap_program: mock_swap::ID,
            },
            terp::instruction::ConvertTax {
                tokens_in,
                swap_data,
            },
        );
        convert.accounts.extend(self.swap_accounts(keys));
        convert
    }

    /// `convert_tax` signed by `signer`, with an arbitrary swap instruction.
    pub fn convert_tax_raw(
        &mut self,
        signer: &str,
        keys: &LaunchKeys,
        tokens_in: u64,
        swap_data: Vec<u8>,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let convert = self.convert_ix(signer, keys, tokens_in, swap_data);
        self.send(signer, vec![convert])
    }

    /// `convert_tax` by the keeper, naming `fee_account` as the keeper fee's destination.
    pub fn convert_tax_paying(
        &mut self,
        keys: &LaunchKeys,
        tokens: u64,
        fee_account: Pubkey,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let data = mock_swap::instruction::Swap {
            amount_in: tokens,
            min_out: 0,
        }
        .data();
        let mut convert = self.convert_ix(KEEPER, keys, tokens, data);
        let treasury_usdc = self.usdc_ata(&self.treasury);
        for meta in &mut convert.accounts {
            if meta.pubkey == treasury_usdc {
                meta.pubkey = fee_account;
            }
        }
        self.send(KEEPER, vec![convert])
    }

    /// The keeper sells `tokens` of tax through the MOCK pool.
    pub fn convert_tax(
        &mut self,
        keys: &LaunchKeys,
        tokens: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let data = mock_swap::instruction::Swap {
            amount_in: tokens,
            min_out: 0,
        }
        .data();
        self.convert_tax_raw(KEEPER, keys, tokens, data)
    }

    /// What the keeper normally sends: sweep, sell and deploy in ONE transaction.
    pub fn collect_convert_deploy(
        &mut self,
        keys: &LaunchKeys,
        sources: &[Pubkey],
        tokens: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let mut collect = ix(
            terp::ID,
            terp::accounts::CollectTax {
                payer: self.keeper,
                launch: keys.launch,
                mint: keys.mint,
                tax_account: keys.tax_account,
                token_2022_program: TOKEN_2022_PROGRAM,
            },
            terp::instruction::CollectTax {},
        );
        collect
            .accounts
            .extend(sources.iter().map(|k| AccountMeta::new(*k, false)));
        let data = mock_swap::instruction::Swap {
            amount_in: tokens,
            min_out: 0,
        }
        .data();
        let convert = self.convert_ix(KEEPER, keys, tokens, data);
        let deploy = self.deploy_ix(KEEPER, keys);
        self.send(KEEPER, vec![collect, convert, deploy])
    }

    /// What the MOCK pool pays for `tokens` sent to it (the pool receives 97%).
    pub fn pool_quote(&self, keys: &LaunchKeys, tokens: u64) -> u64 {
        self.pool_quote_at(keys, tokens, 300)
    }

    pub fn pool_quote_at(&self, keys: &LaunchKeys, tokens: u64, fee_bps: u64) -> u64 {
        let received = tokens - (tokens as u128 * fee_bps as u128).div_ceil(10_000) as u64;
        let token_reserve = self.balance(&keys.pool_token_vault) as u128;
        let usdc_reserve = self.balance(&keys.pool_usdc_vault) as u128;
        (usdc_reserve * received as u128 / (token_reserve + received as u128)) as u64
    }

    // Phoenix

    fn phoenix_accounts(&self, keys: &LaunchKeys) -> terp::accounts::PhoenixAccounts {
        terp::accounts::PhoenixAccounts {
            phoenix_program: PHOENIX_PROGRAM_ID,
            log_authority: PHOENIX_LOG_AUTHORITY,
            global_config: PHOENIX_GLOBAL_CONFIG,
            trader_account: keys.trader_account,
            perp_asset_map: self.exchange.perp_asset_map,
            orderbook: keys.orderbook,
            spline: keys.spline,
            global_vault: self.exchange.global_vault,
            withdraw_queue: self.exchange.withdraw_queue,
            hawkeye_program: HAWKEYE_PROGRAM_ID,
        }
    }

    fn ember_accounts(&self, keys: &LaunchKeys) -> terp::accounts::EmberAccounts {
        terp::accounts::EmberAccounts {
            ember_program: EMBER_PROGRAM_ID,
            ember_state: EMBER_STATE,
            ember_vault: EMBER_VAULT,
            usdc_mint: USDC_MINT,
            canonical_mint: self.exchange.canonical_mint,
            vault_usdc: keys.vault_usdc,
            canonical_account: keys.canonical_account,
            token_program: TOKEN_PROGRAM,
        }
    }

    fn with_tail(&self, mut instruction: Instruction) -> Instruction {
        instruction.accounts.extend(
            self.exchange
                .tail
                .iter()
                .map(|k| AccountMeta::new(*k, false)),
        );
        instruction
    }

    fn deploy_ix(&self, signer: &str, keys: &LaunchKeys) -> Instruction {
        self.with_tail(ix(
            terp::ID,
            terp::accounts::Deploy {
                keeper: self.px.signer_pubkey(signer),
                config: config_pda(),
                launch: keys.launch,
                phoenix: self.phoenix_accounts(keys),
                ember: self.ember_accounts(keys),
            },
            terp::instruction::Deploy {},
        ))
    }

    /// `deploy` signed by `signer`: deposits the vault's idle USDC and, inside the leverage band,
    /// adds exposure. Only the keeper is accepted.
    pub fn deploy(
        &mut self,
        signer: &str,
        keys: &LaunchKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let deploy = self.deploy_ix(signer, keys);
        self.send(signer, vec![deploy])
    }

    fn venue_op(&self, caller: &str, keys: &LaunchKeys, data: impl InstructionData) -> Instruction {
        self.with_tail(ix(
            terp::ID,
            terp::accounts::VenueOp {
                caller: self.px.signer_pubkey(caller),
                launch: keys.launch,
                phoenix: self.phoenix_accounts(keys),
                ember: self.ember_accounts(keys),
            },
            data,
        ))
    }

    pub fn deleverage(
        &mut self,
        caller: &str,
        keys: &LaunchKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let op = self.venue_op(caller, keys, terp::instruction::Deleverage {});
        self.send(caller, vec![op])
    }

    pub fn fund_claims(
        &mut self,
        caller: &str,
        keys: &LaunchKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let op = self.venue_op(caller, keys, terp::instruction::FundClaims {});
        self.send(caller, vec![op])
    }

    pub fn unwrap_canonical(
        &mut self,
        caller: &str,
        keys: &LaunchKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let unwrap = ix(
            terp::ID,
            terp::accounts::UnwrapCanonical {
                caller: self.px.signer_pubkey(caller),
                launch: keys.launch,
                ember: self.ember_accounts(keys),
            },
            terp::instruction::UnwrapCanonical {},
        );
        self.send(caller, vec![unwrap])
    }

    // Redemption

    /// One transaction by the holder: burn `amount`, receive USDC.
    pub fn redeem(
        &mut self,
        owner_seed: &str,
        keys: &LaunchKeys,
        amount: u64,
        min_payout: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let owner = self.px.signer_pubkey(owner_seed);
        let redeem = self.with_tail(ix(
            terp::ID,
            terp::accounts::Redeem {
                owner,
                launch: keys.launch,
                mint: keys.mint,
                token_account: self.token_ata(&owner, &keys.mint),
                owner_usdc: self.usdc_ata(&owner),
                claim: self.claim_pda(keys, &owner),
                phoenix: self.phoenix_accounts(keys),
                ember: self.ember_accounts(keys),
                token_2022_program: TOKEN_2022_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            },
            terp::instruction::Redeem { amount, min_payout },
        ));
        self.send(owner_seed, vec![redeem])
    }

    /// Anyone pays a claim out of the vault's idle USDC; it can only go to its owner.
    pub fn pay_claim(
        &mut self,
        caller: &str,
        keys: &LaunchKeys,
        owner: &Pubkey,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.send(
            caller,
            vec![ix(
                terp::ID,
                terp::accounts::PayClaim {
                    caller: self.px.signer_pubkey(caller),
                    launch: keys.launch,
                    owner: *owner,
                    claim: self.claim_pda(keys, owner),
                    owner_usdc: self.usdc_ata(owner),
                    vault_usdc: keys.vault_usdc,
                    usdc_mint: USDC_MINT,
                    token_program: TOKEN_PROGRAM,
                },
                terp::instruction::PayClaim {},
            )],
        )
    }

    pub fn update_config(
        &mut self,
        args: UpdateConfigArgs,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.send(
            ADMIN,
            vec![ix(
                terp::ID,
                terp::accounts::UpdateConfig {
                    admin: self.admin,
                    config: config_pda(),
                },
                terp::instruction::UpdateConfig { args },
            )],
        )
    }

    pub fn set_paused(&mut self, paused: bool) {
        ok(self.update_config(UpdateConfigArgs {
            admin: None,
            keeper: None,
            treasury: None,
            keeper_fee_bps: None,
            paused: Some(paused),
        }));
    }

    /// Sets the keeper fee for launches created from now on.
    pub fn set_keeper_fee(
        &mut self,
        keeper_fee_bps: u16,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.update_config(UpdateConfigArgs {
            admin: None,
            keeper: None,
            treasury: None,
            keeper_fee_bps: Some(keeper_fee_bps),
            paused: None,
        })
    }

    pub fn sweep_residual(
        &mut self,
        keys: &LaunchKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let treasury = self.treasury;
        ok(self.send(
            TREASURY,
            vec![create_ata_ix(
                &treasury,
                &treasury,
                &USDC_MINT,
                &TOKEN_PROGRAM,
            )],
        ));
        self.send(
            CALLER,
            vec![ix(
                terp::ID,
                terp::accounts::SweepResidual {
                    caller: self.caller,
                    config: config_pda(),
                    launch: keys.launch,
                    mint: keys.mint,
                    vault_usdc: keys.vault_usdc,
                    treasury_usdc: self.usdc_ata(&treasury),
                    usdc_mint: USDC_MINT,
                    token_program: TOKEN_PROGRAM,
                },
                terp::instruction::SweepResidual {},
            )],
        )
    }
}

impl Default for Ctx {
    fn default() -> Self {
        Self::new()
    }
}
