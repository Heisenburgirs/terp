//! The tax sale carried out by the caller's own transaction: begin, pool swap, settle. It is the
//! only way to sell tax for a token whose transfers call back into the program (a transfer
//! hook), and it must be exactly as safe as `convert_tax`: open to anyone, worth nothing to the
//! caller.
use anchor_lang::InstructionData;
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;
const POOL_USDC: u64 = 30_000 * USDC;
const BATCH: u64 = 15_000 * TOKEN;

/// A launch whose tax account holds the 15k tokens withheld when the pool was seeded, and a
/// wallet with no role.
fn with_tax() -> (Ctx, LaunchKeys, Pubkey) {
    let mut ctx = Ctx::new();
    let keys = ctx.launch_with_pool(SUPPLY, POOL_USDC);
    ok(ctx.collect_tax(&keys, &[keys.pool_token_vault]));
    assert_eq!(ctx.balance(&keys.tax_account), BATCH);
    let stranger = ctx.user("stranger", &keys.mint);
    (ctx, keys, stranger)
}

#[test]
fn anyone_sells_a_batch_and_gains_nothing_by_it() {
    let (mut ctx, keys, stranger) = with_tax();
    let pool_paid = ctx.pool_quote(&keys, BATCH);
    let sold = event::<TaxConverted>(&ok(ctx.sell_tax("stranger", &keys, BATCH, false)));
    assert_eq!((sold.tokens_in, sold.usdc_out), (BATCH, pool_paid));
    // the same split as `convert_tax`: 3% to the platform, the rest to the vault
    let fee = platform_fee(pool_paid);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&ctx.treasury)), fee);
    assert_eq!(ctx.balance(&keys.vault_usdc), pool_paid - fee);
    assert_eq!(ctx.balance(&keys.tax_usdc), 0);
    assert_eq!(ctx.balance(&keys.tax_account), 0);
    // nothing for the caller
    assert_eq!(ctx.balance(&ctx.usdc_ata(&stranger)), 0);
    assert_eq!(ctx.balance(&ctx.token_ata(&stranger, &keys.mint)), 0);
    let launch = ctx.launch(&keys);
    assert_eq!(launch.tokens_converted, BATCH);
    assert_eq!(launch.sale_tokens_in, 0);
}

#[test]
fn the_approval_does_not_outlive_the_sale() {
    let (mut ctx, keys, stranger) = with_tax();
    // sell a little under the batch, so tokens remain in the tax account afterwards
    ok(ctx.sell_tax("stranger", &keys, 14_000 * TOKEN, false));
    assert_eq!(ctx.balance(&keys.tax_account), 1_000 * TOKEN);
    // the caller was approved for the sale only: it cannot move what is left
    let grab = ctx.transfer_from(
        "stranger",
        &keys.mint,
        &keys.tax_account,
        &ctx.token_ata(&stranger, &keys.mint),
        1,
    );
    assert!(grab.is_err());
    assert_eq!(ctx.balance(&keys.tax_account), 1_000 * TOKEN);
}

#[test]
fn a_sale_must_be_begin_swap_settle_and_nothing_else() {
    let (mut ctx, keys, stranger) = with_tax();
    let [begin, swap, settle] = ctx.tax_sale_ixs("stranger", &keys, BATCH, false);

    // begin on its own would leave the caller approved with nobody checking the outcome
    assert_err(
        ctx.send("stranger", vec![begin.clone()]),
        VaultError::SaleNotWellFormed,
    );
    // begin and settle with no swap between them
    assert_err(
        ctx.send("stranger", vec![begin.clone(), settle.clone()]),
        VaultError::SwapNotAllowed,
    );
    // something else slipped in before the swap: here, the caller helping itself
    let grab = ctx.transfer_from_ix(
        "stranger",
        &keys.mint,
        &keys.tax_account,
        &ctx.token_ata(&stranger, &keys.mint),
        BATCH,
    );
    assert_err(
        ctx.send(
            "stranger",
            vec![begin.clone(), grab, swap.clone(), settle.clone()],
        ),
        VaultError::SwapNotAllowed,
    );
    // settle with no sale open
    assert_err(
        ctx.send("stranger", vec![settle.clone()]),
        VaultError::SaleState,
    );
    assert_eq!(ctx.balance(&keys.tax_account), BATCH);
    assert_eq!(ctx.balance(&ctx.token_ata(&stranger, &keys.mint)), 0);

    // the well-formed sale goes through
    ok(ctx.send("stranger", vec![begin, swap, settle]));
}

#[test]
fn the_swap_must_be_the_allowlisted_one_on_this_pool_paying_the_vaults_account() {
    let (mut ctx, keys, stranger) = with_tax();
    let [begin, swap, settle] = ctx.tax_sale_ixs("stranger", &keys, BATCH, false);

    // an instruction of the pool program that is not on the allowlist
    let mut other_instruction = swap.clone();
    other_instruction.data = mock_swap::instruction::InitPool {}.data();
    assert_err(
        ctx.send(
            "stranger",
            vec![begin.clone(), other_instruction, settle.clone()],
        ),
        VaultError::SwapNotAllowed,
    );

    // a swap that takes the tokens and pays nothing (allowlisted in tests for exactly this):
    // settle sees no USDC and the whole transaction reverts, tokens included
    let mut keep = swap.clone();
    keep.data = mock_swap::instruction::SwapAndKeep { amount_in: BATCH }.data();
    assert_err(
        ctx.send("stranger", vec![begin.clone(), keep, settle.clone()]),
        VaultError::SlippageExceeded,
    );
    assert_eq!(ctx.balance(&keys.tax_account), BATCH);

    // the right instruction, but the proceeds pointed at the caller's own USDC account
    let mut redirected = swap.clone();
    redirected.accounts[5].pubkey = ctx.usdc_ata(&stranger);
    assert_err(
        ctx.send("stranger", vec![begin.clone(), redirected, settle.clone()]),
        VaultError::SaleNotWellFormed,
    );

    // another launch's pool
    let other = ctx.launch_with_pool(SUPPLY, POOL_USDC);
    let [_, other_swap, _] = ctx.tax_sale_ixs("stranger", &other, BATCH, false);
    assert_err(
        ctx.send("stranger", vec![begin, other_swap, settle]),
        VaultError::SaleNotWellFormed,
    );
    assert_eq!(ctx.balance(&keys.tax_account), BATCH);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&stranger)), 0);
}

#[test]
fn the_size_and_cooldown_rules_are_those_of_convert_tax() {
    let (mut ctx, keys, _) = with_tax();
    // a trickle instead of the batch
    assert_err(
        ctx.sell_tax("stranger", &keys, 1_000 * TOKEN, false),
        VaultError::ConversionWrongSize,
    );
    ok(ctx.sell_tax("stranger", &keys, BATCH, false));
    // paused: no sale
    ctx.set_paused(true);
    assert_err(
        ctx.sell_tax("stranger", &keys, BATCH, false),
        VaultError::Paused,
    );
}

#[test]
fn a_hooked_tokens_tax_is_sold_this_way_and_only_this_way() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::hooked(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    ok(ctx.init_hook(&keys));
    ctx.create_pool_hooked(&keys, SUPPLY / 2, POOL_USDC);
    ok(ctx.collect_tax(&keys, &[keys.pool_token_vault]));
    assert_eq!(ctx.balance(&keys.tax_account), BATCH);
    ctx.user("stranger", &keys.mint);

    // `convert_tax` has the program call the pool, whose transfer calls the program's hook:
    // Solana refuses that loop
    let looped = ctx
        .convert_tax_hooked(&keys, BATCH)
        .expect_err("the program cannot be re-entered");
    assert!(
        format!("{:?}", looped.err).contains("ReentrancyNotAllowed"),
        "{:?}",
        looped.err
    );

    // the caller-carried sale works: the pool is called by the transaction, not by the program
    let pool_paid = ctx.pool_quote(&keys, BATCH);
    let sold = event::<TaxConverted>(&ok(ctx.sell_tax("stranger", &keys, BATCH, true)));
    assert_eq!(sold.usdc_out, pool_paid);
    assert_eq!(
        ctx.balance(&keys.vault_usdc),
        pool_paid - platform_fee(pool_paid)
    );
}
