//! Tax collection and conversion. The keeper decides when; the program decides how much, at
//! what price, and where the money goes.
use anchor_lang::InstructionData;
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;
const POOL_USDC: u64 = 30_000 * USDC;

fn swap(amount_in: u64) -> Vec<u8> {
    mock_swap::instruction::Swap {
        amount_in,
        min_out: 0,
    }
    .data()
}

/// A launch whose tax account holds the 15k tokens withheld when the pool was seeded.
fn with_tax_and(args: CreateLaunchArgs) -> (Ctx, LaunchKeys) {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ok(ctx.create_launch(mint, args));
    let keys = ctx.keys(mint);
    ctx.create_pool(&keys, SUPPLY / 2, POOL_USDC);
    ok(ctx.collect_tax(&keys, &[keys.pool_token_vault]));
    assert_eq!(ctx.balance(&keys.tax_account), 15_000 * TOKEN);
    (ctx, keys)
}

fn with_tax() -> (Ctx, LaunchKeys) {
    with_tax_and(default_args(SUPPLY))
}

/// Batches of at most 5k tokens, so one collection takes several conversions.
fn small_batches() -> CreateLaunchArgs {
    CreateLaunchArgs {
        max_convert_tokens: 5_000 * TOKEN,
        ..default_args(SUPPLY)
    }
}

#[test]
fn collection_is_permissionless_and_only_ever_pays_the_tokens_own_vault() {
    let mut ctx = Ctx::new();
    let keys = ctx.launch_with_pool(SUPPLY, POOL_USDC);
    let alice = ctx.user("alice", &keys.mint);
    let alice_tokens = ctx.token_ata(&alice, &keys.mint);
    ok(ctx.transfer(CREATOR, &keys.mint, &alice_tokens, 10_000 * TOKEN));

    // sent by a wallet with no role
    let collected = event::<TaxCollected>(&ok(
        ctx.collect_tax(&keys, &[alice_tokens, keys.pool_token_vault])
    ));
    // 3% of the pool seed and 3% of Alice's transfer
    assert_eq!(collected.tokens, 15_000 * TOKEN + 300 * TOKEN);
    assert_eq!(ctx.launch(&keys).tokens_collected, collected.tokens);
    // Alice keeps what she received; collection took only the withheld part
    assert_eq!(ctx.balance(&alice_tokens), 9_700 * TOKEN);

    assert_err(
        ctx.collect_tax(&keys, &[alice_tokens]),
        VaultError::NothingCollected,
    );
}

#[test]
fn proceeds_are_what_the_pool_paid_split_between_the_vault_and_the_platform_fee() {
    let (mut ctx, keys) = with_tax();
    let pool_paid = ctx.pool_quote(&keys, 15_000 * TOKEN);
    let converted = event::<TaxConverted>(&ok(ctx.convert_tax(&keys, 15_000 * TOKEN)));
    assert_eq!(converted.usdc_out, pool_paid);
    // the launch's fixed 3% keeper fee goes to the platform treasury, the rest to the vault
    let fee = keeper_fee(pool_paid);
    assert_eq!(converted.keeper_fee, fee);
    assert_eq!(ctx.launch(&keys).keeper_fee_bps, KEEPER_FEE_BPS);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&ctx.treasury)), fee);
    assert_eq!(ctx.balance(&keys.vault_usdc), pool_paid - fee);
    // nothing is left in the pass-through account, and the keeper key holds nothing
    assert_eq!(ctx.balance(&keys.tax_usdc), 0);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&ctx.keeper)), 0);

    // naive "3% of volume at spot" overstates it: the sale itself pays the transfer tax and
    // moves the price
    let spot_value =
        (15_000 * TOKEN as u128 * POOL_USDC as u128 / (485_000 * TOKEN) as u128) as u64;
    assert!(pool_paid < spot_value * 97 / 100);
    let launch = ctx.launch(&keys);
    assert_eq!(launch.usdc_converted, pool_paid - fee);
    assert_eq!(launch.keeper_fees_paid, fee);
}

#[test]
fn only_the_keeper_converts() {
    let (mut ctx, keys) = with_tax();
    ctx.user("stranger", &keys.mint);
    assert_err(
        ctx.convert_tax_raw("stranger", &keys, 15_000 * TOKEN, swap(15_000 * TOKEN)),
        VaultError::Unauthorized,
    );
    assert_err(
        ctx.convert_tax_raw(CREATOR, &keys, 15_000 * TOKEN, swap(15_000 * TOKEN)),
        VaultError::Unauthorized,
    );
    ok(ctx.convert_tax(&keys, 15_000 * TOKEN));
}

#[test]
fn the_keeper_cannot_choose_the_batch_size() {
    let (mut ctx, keys) = with_tax();
    // the batch is the whole 15k balance (the cap is 50k); a trickle is refused
    assert_err(
        ctx.convert_tax_raw(KEEPER, &keys, 1_000 * TOKEN, swap(1_000 * TOKEN)),
        VaultError::ConversionWrongSize,
    );
    assert_err(
        ctx.convert_tax_raw(KEEPER, &keys, 13_499 * TOKEN, swap(13_499 * TOKEN)),
        VaultError::ConversionWrongSize,
    );
    // and a swap that spends more than it declared is refused
    assert_err(
        ctx.convert_tax_raw(KEEPER, &keys, 14_000 * TOKEN, swap(15_000 * TOKEN)),
        VaultError::ConversionWrongSize,
    );
    // within 10% of the batch is accepted, so tax arriving mid-flight does not break it
    ok(ctx.convert_tax_raw(KEEPER, &keys, 13_500 * TOKEN, swap(13_500 * TOKEN)));
}

#[test]
fn a_swap_that_takes_the_tokens_and_pays_nothing_is_rejected() {
    let (mut ctx, keys) = with_tax();
    let data = mock_swap::instruction::SwapAndKeep {
        amount_in: 15_000 * TOKEN,
    }
    .data();
    assert_err(
        ctx.convert_tax_raw(KEEPER, &keys, 15_000 * TOKEN, data),
        VaultError::SlippageExceeded,
    );
    // the whole transaction reverted: the tax tokens are still there
    assert_eq!(ctx.balance(&keys.tax_account), 15_000 * TOKEN);
}

#[test]
fn an_instruction_outside_the_allowlist_is_rejected() {
    let (mut ctx, keys) = with_tax();
    let data = mock_swap::instruction::InitPool {}.data();
    assert_err(
        ctx.convert_tax_raw(KEEPER, &keys, 15_000 * TOKEN, data),
        VaultError::SwapNotAllowed,
    );
}

#[test]
fn nothing_converts_below_the_threshold() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    ctx.create_pool(&keys, SUPPLY / 2, POOL_USDC);
    // 3% of a 3,000-token transfer is 90 tokens, under the 100-token threshold
    let alice = ctx.user("alice", &mint);
    let alice_tokens = ctx.token_ata(&alice, &mint);
    ok(ctx.transfer(CREATOR, &mint, &alice_tokens, 3_000 * TOKEN));
    ok(ctx.collect_tax(&keys, &[alice_tokens]));
    assert_err(
        ctx.convert_tax(&keys, 90 * TOKEN),
        VaultError::ConversionTooSmall,
    );

    // one more transfer crosses it
    ok(ctx.transfer(CREATOR, &mint, &alice_tokens, 1_000 * TOKEN));
    ok(ctx.collect_tax(&keys, &[alice_tokens]));
    ok(ctx.convert_tax(&keys, 120 * TOKEN));
}

#[test]
fn batches_are_capped_and_spaced_by_the_cooldown() {
    let (mut ctx, keys) = with_tax_and(small_batches());
    // the cap is 5k: more cannot be sold in one go
    assert_err(
        ctx.convert_tax(&keys, 15_000 * TOKEN),
        VaultError::ConversionWrongSize,
    );
    ok(ctx.convert_tax(&keys, 5_000 * TOKEN));
    assert_err(
        ctx.convert_tax(&keys, 5_000 * TOKEN),
        VaultError::ConversionCooldown,
    );
    ctx.warp(10);
    ok(ctx.convert_tax(&keys, 5_000 * TOKEN));
}

#[test]
fn the_first_conversion_is_protected_by_the_launch_price() {
    let (mut ctx, keys) = with_tax_and(small_batches());
    // before any conversion, someone dumps into the pool; even the keeper cannot sell into it
    ok(ctx.transfer(CREATOR, &keys.mint, &keys.pool_token_vault, 200_000 * TOKEN));
    assert_err(
        ctx.convert_tax(&keys, 5_000 * TOKEN),
        VaultError::ConversionPriceTooLow,
    );
    assert_eq!(ctx.balance(&keys.tax_account), 15_000 * TOKEN);
}

#[test]
fn a_conversion_into_a_dumped_pool_is_refused_until_the_price_has_had_time_to_settle() {
    let (mut ctx, keys) = with_tax_and(small_batches());
    ok(ctx.convert_tax(&keys, 5_000 * TOKEN));
    let reference = ctx.launch(&keys).ema_price;

    // a sandwich: a large sale into the pool right before the keeper's conversion lands
    ok(ctx.transfer(CREATOR, &keys.mint, &keys.pool_token_vault, 200_000 * TOKEN));
    ctx.warp(10);
    assert_err(
        ctx.convert_tax(&keys, 5_000 * TOKEN),
        VaultError::ConversionPriceTooLow,
    );
    assert_eq!(ctx.balance(&keys.tax_account), 10_000 * TOKEN);

    // the floor loosens by max_price_drop_bps (10%) per cooldown period, so a real repricing
    // only delays conversion: the pool is about 29% lower, which clears after 4 periods
    ctx.warp(30);
    ok(ctx.convert_tax(&keys, 5_000 * TOKEN));
    assert!(ctx.launch(&keys).ema_price < reference);
}

#[test]
fn pausing_stops_conversion() {
    let (mut ctx, keys) = with_tax();
    ctx.set_paused(true);
    assert_err(ctx.convert_tax(&keys, 15_000 * TOKEN), VaultError::Paused);
}

#[test]
fn conversion_needs_the_launch_pool_in_the_swap() {
    let mut ctx = Ctx::new();
    // a launch with tax but no pool recorded
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    let alice = ctx.user("alice", &mint);
    let alice_tokens = ctx.token_ata(&alice, &mint);
    ok(ctx.transfer(CREATOR, &mint, &alice_tokens, 100_000 * TOKEN));
    ok(ctx.collect_tax(&keys, &[alice_tokens]));
    assert_err(
        ctx.convert_tax(&keys, 3_000 * TOKEN),
        VaultError::SwapPoolMissing,
    );
}

#[test]
fn the_keeper_fee_can_only_go_to_the_configured_treasury() {
    let (mut ctx, keys) = with_tax();
    // the keeper names another wallet's USDC account, or the vault itself, as the fee's destination
    let caller_usdc = ctx.usdc_ata(&ctx.caller);
    let stranger = ctx.user("stranger", &keys.mint);
    let stranger_usdc = ctx.usdc_ata(&stranger);
    for account in [caller_usdc, stranger_usdc, keys.vault_usdc] {
        let failed = ctx
            .convert_tax_paying(&keys, 15_000 * TOKEN, account)
            .expect_err("only the treasury's account is accepted");
        assert!(
            failed.meta.logs.iter().any(|l| l.contains("treasury_usdc")),
            "{:?}",
            failed.meta.logs
        );
    }
    assert_eq!(ctx.balance(&keys.tax_account), 15_000 * TOKEN);
    assert_eq!(ctx.balance(&caller_usdc) + ctx.balance(&stranger_usdc), 0);
}

#[test]
fn a_launch_keeps_the_keeper_fee_it_was_created_with() {
    let (mut ctx, keys) = with_tax();
    // the platform cannot set a fee above the 20% cap
    assert_err(ctx.set_keeper_fee(2_001), VaultError::InvalidParameter);
    // it raises the fee to the cap; that applies to launches created afterwards only
    ok(ctx.set_keeper_fee(2_000));
    assert_eq!(ctx.launch(&keys).keeper_fee_bps, KEEPER_FEE_BPS);
    let pool_paid = ctx.pool_quote(&keys, 15_000 * TOKEN);
    let converted = event::<TaxConverted>(&ok(ctx.convert_tax(&keys, 15_000 * TOKEN)));
    assert_eq!(converted.keeper_fee, keeper_fee(pool_paid));

    let later = ctx.launch_with_pool(SUPPLY, POOL_USDC);
    assert_eq!(ctx.launch(&later).keeper_fee_bps, 2_000);
    ok(ctx.collect_tax(&later, &[later.pool_token_vault]));
    let before = ctx.balance(&ctx.usdc_ata(&ctx.treasury));
    let pool_paid = ctx.pool_quote(&later, 15_000 * TOKEN);
    let converted = event::<TaxConverted>(&ok(ctx.convert_tax(&later, 15_000 * TOKEN)));
    assert_eq!(converted.keeper_fee, pool_paid / 5);
    assert_eq!(
        ctx.balance(&ctx.usdc_ata(&ctx.treasury)) - before,
        pool_paid / 5
    );
    assert_eq!(ctx.balance(&later.vault_usdc), pool_paid - pool_paid / 5);
}
