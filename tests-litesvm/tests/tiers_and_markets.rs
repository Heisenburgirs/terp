//! What a creator picks at launch, fixed for good: the tax tier (1% or 3%) and the leveraged
//! asset the tax is put into.
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;

fn tier(fee_bps: u16) -> MintOpts {
    MintOpts {
        fee_bps,
        ..MintOpts::valid(SUPPLY)
    }
}

#[test]
fn a_one_percent_launch_taxes_one_percent_into_its_own_vault() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(tier(100));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    assert_eq!(ctx.launch(&keys).transfer_fee_bps, 100);
    ctx.create_pool(&keys, SUPPLY / 2, 30_000 * USDC);

    // every transfer leaves 1% withheld, whoever sends it and wherever it goes
    let alice = ctx.user("alice", &mint);
    let alice_tokens = ctx.token_ata(&alice, &mint);
    ok(ctx.transfer(CREATOR, &mint, &alice_tokens, 10_000 * TOKEN));
    assert_eq!(ctx.balance(&alice_tokens), 9_900 * TOKEN);

    // the launch's vault is the only place that tax can go
    let collected = event::<TaxCollected>(&ok(
        ctx.collect_tax(&keys, &[alice_tokens, keys.pool_token_vault])
    ));
    assert_eq!(collected.tokens, 5_000 * TOKEN + 100 * TOKEN);
    assert_eq!(ctx.balance(&keys.tax_account), 5_100 * TOKEN);

    // and it is sold into the token's own pool for the quote asset
    let pool_paid = ctx.pool_quote_at(&keys, 5_100 * TOKEN, 100);
    let converted = event::<TaxConverted>(&ok(ctx.convert_tax(&keys, 5_100 * TOKEN)));
    assert_eq!(converted.usdc_out, pool_paid);
    assert_eq!(
        ctx.balance(&keys.vault_usdc),
        pool_paid - platform_fee(pool_paid)
    );
}

#[test]
fn a_three_percent_launch_records_its_tier() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(tier(300));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    assert_eq!(ctx.launch(&ctx.keys(mint)).transfer_fee_bps, 300);
}

#[test]
fn only_the_published_tiers_are_accepted() {
    for fee_bps in [0, 50, 200, 500, 1_000] {
        let mut ctx = Ctx::new();
        let mint = ctx.create_mint(tier(fee_bps));
        assert_err(
            ctx.create_launch(mint, default_args(SUPPLY)),
            VaultError::InvalidTransferFee,
        );
    }
}

#[test]
fn a_launch_levers_the_asset_it_chose() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ok(ctx.create_launch_on(mint, default_args(SUPPLY), BTC_ASSET_ID));
    let keys = ctx.keys_on(mint, BTC_ASSET_ID);
    let launch = ctx.launch(&keys);
    assert_eq!(launch.asset_id, BTC_ASSET_ID);
    assert_eq!(&launch.symbol[..3], b"BTC");
    assert_eq!(launch.orderbook, ctx.market(BTC_ASSET_ID).orderbook);

    ok(ctx.register_trader(&keys));
    ctx.onboard(&keys);
    ctx.fund_vault(&keys, 1_000 * USDC);
    let deployed = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(deployed.deposited, 1_000 * USDC);
    // a BTC long was opened: one base lot is 0.0001 BTC, $10 at the fixture's $100,000
    assert!(deployed.filled_base_lots > 0);
    assert_eq!(
        deployed.notional_after,
        deployed.filled_base_lots * 10 * USDC
    );
    assert!(deployed.leverage_bps_after <= 50_500);
    // and nothing was opened on SOL
    assert_eq!(ctx.perp(&keys).base_lots, 0);

    // the launch cannot be pointed at another market afterwards
    let sol = ctx.market(SOL_ASSET_ID);
    let mut crossed = keys;
    crossed.orderbook = sol.orderbook;
    crossed.spline = sol.spline;
    ctx.fund_vault(&keys, 100 * USDC);
    assert_err(
        ctx.deploy(KEEPER, &crossed),
        VaultError::InvalidPhoenixAccount,
    );
}

#[test]
fn only_the_admin_lists_markets_and_a_listing_is_permanent() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ctx.user("mallory", &mint);
    const ETH: u32 = 1;

    assert_err(
        ctx.add_market("mallory", "ETH", ETH, 10, 3),
        VaultError::Unauthorized,
    );
    ok(ctx.add_market(ADMIN, "ETH", ETH, 10, 3));
    assert_eq!(&ctx.market(ETH).symbol[..3], b"ETH");
    // it cannot be listed again with different parameters
    assert!(ctx.add_market(ADMIN, "ETH", ETH, 999, 3).is_err());
    assert_eq!(ctx.market(ETH).tick_size, 10);

    // a launch cannot name a market that was never listed
    assert!(ctx
        .create_launch_on(mint, default_args(SUPPLY), 77)
        .is_err());
}
