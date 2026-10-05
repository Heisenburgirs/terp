//! Scenario shortcuts shared by the test files.
use anchor_lang::{InstructionData, ToAccountMetas};
use phoenix_rise_litesvm_test::decode_fixture_instruction;
use solana_instruction::Instruction;

use crate::*;

/// SOL notional of one base lot at [SOL_PRICE], in USDC atoms.
pub const LOT_USDC: u64 = 1_500_000;

impl Ctx {
    /// SIMULATED revenue: mints USDC straight into the vault instead of running the tax flow.
    pub fn fund_vault(&mut self, keys: &LaunchKeys, usdc: u64) {
        self.mint_usdc(&keys.vault_usdc, usdc);
    }

    /// A launch whose vault deposited `collateral` and opened a long just under 5x.
    /// Leaves the clock past Phoenix's post-deposit withdrawal cooldown with a fresh mark.
    pub fn levered_launch(&mut self, supply: u64, collateral: u64) -> LaunchKeys {
        let keys = self.ready_launch(supply, 30_000 * USDC);
        self.lever(&keys, collateral);
        keys
    }

    pub fn lever(&mut self, keys: &LaunchKeys, collateral: u64) {
        self.fund_vault(keys, collateral);
        // earlier launches in the same test may have taken the maker levels
        self.replenish_book();
        let deployed = event::<Deployed>(&ok(self.deploy(KEEPER, keys)));
        assert_eq!(deployed.deposited, collateral);
        assert_eq!(deployed.filled_base_lots, deployed.requested_base_lots);
        assert!(deployed.filled_base_lots > 0);
        self.settle_clock();
    }

    /// Passes Phoenix's deposit cooldown and refreshes the mark price slot.
    pub fn settle_clock(&mut self) {
        self.warp(200);
        self.set_sol_price(SOL_PRICE);
    }

    /// Restores the fixture's maker levels around the original price.
    pub fn replenish_book(&mut self) {
        self.px.send_fixture_transaction("orderbookPlaceLevels");
    }

    pub fn set_pool_as(
        &mut self,
        signer: &str,
        keys: &LaunchKeys,
        pool: Pubkey,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let set = Instruction {
            program_id: terp::ID,
            accounts: terp::accounts::SetPool {
                creator: self.px.signer_pubkey(signer),
                config: config_pda(),
                launch: keys.launch,
                pool,
            }
            .to_account_metas(None),
            data: terp::instruction::SetPool {}.data(),
        };
        self.send(signer, vec![set])
    }

    /// Sets the exchange-wide withdraw budget (in quote lots) so withdrawals get queued.
    pub fn set_withdraw_budget(&mut self, max_budget: u64, replenish_per_slot: u64) {
        let template = self
            .px
            .fixture
            .setup_transactions
            .iter()
            .flat_map(|transaction| &transaction.instructions)
            .find(|instruction| instruction.name == "updateWithdrawRateLimits")
            .expect("fixture has updateWithdrawRateLimits");
        let mut update = decode_fixture_instruction(template).unwrap();
        update.data.truncate(8);
        for value in [max_budget, replenish_per_slot] {
            update.data.push(1);
            update.data.extend_from_slice(&value.to_le_bytes());
        }
        self.px
            .send_instructions(vec![update], "payer", "update-withdraw-rate-limits");
    }

    /// Whether the launch's trader has a withdrawal waiting in the exchange queue.
    pub fn has_queued_withdrawal(&self, keys: &LaunchKeys) -> bool {
        let data = self.px.account_data(&keys.trader_account);
        u32::from_le_bytes(data[108..112].try_into().unwrap()) != 0
    }

    /// SIMULATED: Phoenix's queue crank paying a queued withdrawal of `amount` into the vault's
    /// canonical token account. The fixture payer wraps USDC through Ember and transfers it;
    /// the trader's collateral is debited and its queue slot cleared by hand.
    pub fn pay_queued_withdrawal(&mut self, keys: &LaunchKeys, amount: u64) {
        let payer = self.px.signer_pubkey("payer");
        let canonical_mint = self.exchange.canonical_mint;
        let payer_usdc = ata(&payer, &USDC_MINT, &TOKEN_PROGRAM);
        let payer_canonical = ata(&payer, &canonical_mint, &TOKEN_PROGRAM);
        let create = |mint: &Pubkey| Instruction {
            program_id: ATA_PROGRAM,
            accounts: vec![
                solana_instruction::AccountMeta::new(payer, true),
                solana_instruction::AccountMeta::new(ata(&payer, mint, &TOKEN_PROGRAM), false),
                solana_instruction::AccountMeta::new_readonly(payer, false),
                solana_instruction::AccountMeta::new_readonly(*mint, false),
                solana_instruction::AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                solana_instruction::AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            ],
            data: vec![1],
        };
        self.px.send_instructions(
            vec![create(&USDC_MINT), create(&canonical_mint)],
            "payer",
            "payer-atas",
        );
        self.mint_usdc(&payer_usdc, amount);

        let mut ember_deposit = sighash("deposit").to_vec();
        ember_deposit.extend_from_slice(&amount.to_le_bytes());
        let mut transfer = vec![3];
        transfer.extend_from_slice(&amount.to_le_bytes());
        self.px.send_instructions(
            vec![
                Instruction {
                    program_id: EMBER_PROGRAM_ID,
                    accounts: vec![
                        solana_instruction::AccountMeta::new_readonly(payer, true),
                        solana_instruction::AccountMeta::new_readonly(EMBER_STATE, false),
                        solana_instruction::AccountMeta::new_readonly(USDC_MINT, false),
                        solana_instruction::AccountMeta::new(canonical_mint, false),
                        solana_instruction::AccountMeta::new(payer_usdc, false),
                        solana_instruction::AccountMeta::new(payer_canonical, false),
                        solana_instruction::AccountMeta::new(EMBER_VAULT, false),
                        solana_instruction::AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                    ],
                    data: ember_deposit,
                },
                Instruction {
                    program_id: TOKEN_PROGRAM,
                    accounts: vec![
                        solana_instruction::AccountMeta::new(payer_canonical, false),
                        solana_instruction::AccountMeta::new(keys.canonical_account, false),
                        solana_instruction::AccountMeta::new_readonly(payer, true),
                    ],
                    data: transfer,
                },
            ],
            "payer",
            "pay-queued-withdrawal",
        );

        let mut account = self.px.svm.get_account(&keys.trader_account).unwrap();
        let collateral =
            i64::from_le_bytes(account.data[88..96].try_into().unwrap()) - amount as i64;
        account.data[88..96].copy_from_slice(&collateral.to_le_bytes());
        account.data[108..112].copy_from_slice(&0u32.to_le_bytes());
        self.px
            .svm
            .set_account(keys.trader_account, account)
            .unwrap();
    }

    /// What the UI would show for redeeming `amount` now, computed off-chain from chain state.
    pub fn preview(&mut self, keys: &LaunchKeys, amount: u64) -> math::RedemptionQuote {
        let equity = self.equity(keys);
        let notional = if self.exists(&keys.trader_account) {
            self.perp(keys).notional
        } else {
            0
        };
        math::quote_redemption(amount, self.supply(&keys.mint), equity, notional, 300, 5).unwrap()
    }
}
