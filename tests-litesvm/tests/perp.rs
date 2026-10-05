//! The position strategy: stay open, stay close to 5x. Tax is margin first; under 4.75x exposure
//! is bought back up to 5x; above 6x anyone may cut the position to 5.5x. Callers only
//! trigger; the program sizes everything.
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;
const COLLATERAL: u64 = 1_000 * USDC;

fn funded() -> (Ctx, LaunchKeys) {
    let mut ctx = Ctx::new();
    let keys = ctx.ready_launch(SUPPLY, 30_000 * USDC);
    ctx.fund_vault(&keys, COLLATERAL);
    ctx.user("stranger", &keys.mint);
    (ctx, keys)
}

/// A vault that opened a ~4.9x long at the fixture's ask, a little above mark.
fn levered() -> (Ctx, LaunchKeys) {
    let mut ctx = Ctx::new();
    let keys = ctx.levered_launch(SUPPLY, COLLATERAL);
    ctx.user("stranger", &keys.mint);
    (ctx, keys)
}

fn in_band(leverage_bps: u64) -> bool {
    (48_000..=50_500).contains(&leverage_bps)
}

#[test]
fn nothing_is_deployed_before_the_trader_account_exists() {
    let mut ctx = Ctx::new();
    let keys = ctx.launch_with_pool(SUPPLY, 30_000 * USDC);
    ctx.fund_vault(&keys, COLLATERAL);
    assert_err(ctx.deploy(KEEPER, &keys), VaultError::TraderNotRegistered);
    assert_eq!(ctx.balance(&keys.vault_usdc), COLLATERAL);
}

#[test]
fn registration_is_idempotent_and_binds_the_trader_to_the_launch() {
    let mut ctx = Ctx::new();
    let keys = ctx.launch_with_pool(SUPPLY, 30_000 * USDC);
    let registered = event::<TraderRegistered>(&ok(ctx.register_trader(&keys)));
    assert_eq!(registered.trader_account, keys.trader_account);
    assert_eq!(ctx.launch(&keys).trader_account, keys.trader_account);
    assert_err(
        ctx.register_trader(&keys),
        VaultError::TraderAlreadyRegistered,
    );
}

#[test]
fn anyone_deploys_and_the_program_sizes_the_position() {
    let (mut ctx, keys) = funded();
    // No role is needed: the caller supplies nothing but the moment, and receives nothing.
    // a vault with no position opens one at 5x on its first deposit
    let deployed = event::<Deployed>(&ok(ctx.deploy("stranger", &keys)));
    assert_eq!(deployed.deposited, COLLATERAL);
    assert_eq!(
        (deployed.leverage_bps_before, deployed.unrealized_pnl),
        (0, 0)
    );
    assert!(deployed.increased);
    // 5x the collateral less 2% headroom, in whole lots of $1.50
    let expected_lots = COLLATERAL * 5 * 98 / 100 / LOT_USDC;
    assert_eq!(deployed.requested_base_lots, expected_lots);
    assert_eq!(deployed.filled_base_lots, expected_lots);
    assert!(
        in_band(deployed.leverage_bps_after),
        "{}",
        deployed.leverage_bps_after
    );

    assert_eq!(ctx.balance(&keys.vault_usdc), 0);
    assert_eq!(ctx.perp(&keys).base_lots, expected_lots as i64);
    assert_eq!(ctx.launch(&keys).usdc_deposited, COLLATERAL);
}

#[test]
fn nothing_is_deployed_below_the_threshold() {
    let mut ctx = Ctx::new();
    let keys = ctx.ready_launch(SUPPLY, 30_000 * USDC);
    ctx.fund_vault(&keys, 10 * USDC - 1);
    assert_err(ctx.deploy(KEEPER, &keys), VaultError::NothingToDeploy);
    ctx.fund_vault(&keys, 1);
    let deployed = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(deployed.deposited, 10 * USDC);
    assert!(deployed.filled_base_lots > 0);
}

#[test]
fn after_a_fall_tax_is_margin_first_and_exposure_only_returns_under_the_minimum() {
    let (mut ctx, keys) = levered();
    let opened = ctx.perp(&keys);
    // SOL is down 3% from the start: leverage is above 5x
    ctx.set_sol_price(145.5);
    let fallen = ctx.perp(&keys).leverage_bps();
    assert!(fallen > 50_500 && fallen < 60_000, "{fallen}");

    // Tax arrives. Leverage after the deposit is still above 4.75x, so it is margin only: the
    // position is untouched and liquidation moves further away.
    ctx.fund_vault(&keys, 100 * USDC);
    let margin = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(margin.deposited, 100 * USDC);
    assert!(!margin.increased);
    assert_eq!(margin.filled_base_lots, 0);
    assert_eq!(margin.base_lots_after, opened.base_lots);
    assert!((47_500..fallen).contains(&margin.leverage_bps_after));
    // with no new tax there is nothing for the keeper to do
    assert_err(ctx.deploy(KEEPER, &keys), VaultError::NothingToDeploy);

    // SOL recovers to where it started. With the added margin leverage is now under 4.75x, so
    // exposure is bought back up to 5x. The position is still below its entry price (it bought
    // at the ask): the rule is leverage, not profit.
    ctx.set_sol_price(SOL_PRICE);
    assert!(ctx.perp(&keys).leverage_bps() < 47_500);
    let topped = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(topped.deposited, 0);
    assert!(topped.increased && topped.unrealized_pnl < 0);
    assert!(topped.base_lots_after > opened.base_lots);
    assert!(
        in_band(topped.leverage_bps_after),
        "{}",
        topped.leverage_bps_after
    );
}

#[test]
fn a_small_drift_under_target_is_left_alone() {
    let (mut ctx, keys) = levered();
    // SOL is up a little: leverage has slipped under 5x but not under 4.75x
    ctx.set_sol_price(150.6);
    let leverage = ctx.perp(&keys).leverage_bps();
    assert!((47_500..50_000).contains(&leverage), "{leverage}");
    // no trade, so no taker fee, for a drift this small
    assert_err(ctx.deploy(KEEPER, &keys), VaultError::NothingToDeploy);
}

#[test]
fn after_a_rally_tax_tops_the_position_up_to_five_times() {
    let (mut ctx, keys) = levered();
    let opened = ctx.perp(&keys);

    // SOL is up 4%: leverage has drifted under 4.75x
    ctx.set_sol_price(156.0);
    let drifted = ctx.perp(&keys);
    assert!(
        drifted.leverage_bps() < 47_500,
        "{}",
        drifted.leverage_bps()
    );

    // the next tax goes in as collateral AND exposure is added, back up to 5x
    ctx.fund_vault(&keys, 100 * USDC);
    let first = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(first.deposited, 100 * USDC);
    assert!(first.increased);
    assert_eq!(first.filled_base_lots, first.requested_base_lots);
    assert!(first.base_lots_after > opened.base_lots);
    assert!(first.leverage_bps_after > first.leverage_bps_before);
    assert!(
        first.leverage_bps_after <= 50_500,
        "{}",
        first.leverage_bps_after
    );

    // and again with the next batch: a perpetual 5x, never above it
    ctx.fund_vault(&keys, 100 * USDC);
    let second = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert!(second.increased && second.base_lots_after > first.base_lots_after);
    assert!(
        second.leverage_bps_after <= 50_500,
        "{}",
        second.leverage_bps_after
    );
    let now = ctx.perp(&keys);
    assert!(now.notional > drifted.notional && now.equity() > drifted.equity());
}

#[test]
fn a_position_under_the_minimum_is_topped_up_even_without_new_tax() {
    let (mut ctx, keys) = levered();
    let opened = ctx.perp(&keys);
    ctx.set_sol_price(165.0);
    let rallied = ctx.perp(&keys).leverage_bps();
    assert!(rallied < 40_000, "{rallied}");

    let topped = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(topped.deposited, 0);
    assert!(topped.increased && topped.base_lots_after > opened.base_lots);
    assert!(topped.leverage_bps_after > rallied && topped.leverage_bps_after <= 50_500);
}

#[test]
fn a_position_that_was_closed_is_reopened_by_the_next_tax() {
    let mut ctx = Ctx::new();
    // the creator holds the whole supply of a levered vault and redeems all but one token,
    // which closes the entire position and takes all of the collateral but the retained fee
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    ok(ctx.register_trader(&keys));
    ctx.onboard(&keys);
    ctx.lever(&keys, COLLATERAL);
    ok(ctx.redeem(CREATOR, &keys, SUPPLY - TOKEN, 1));
    let flat = ctx.perp(&keys);
    assert_eq!(flat.base_lots, 0);
    // what stays behind is the redemption fee, sitting as collateral with no position on it
    assert!(flat.collateral < 50 * USDC as i64);

    // the vault does not stay flat: the next tax opens a new position at 5x
    ctx.fund_vault(&keys, 500 * USDC);
    ctx.replenish_book();
    let reopened = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(reopened.deposited, 500 * USDC);
    assert_eq!(reopened.leverage_bps_before, 0);
    assert!(reopened.increased && reopened.filled_base_lots > 0);
    assert!(
        in_band(reopened.leverage_bps_after),
        "{}",
        reopened.leverage_bps_after
    );
    assert_eq!(ctx.perp(&keys).base_lots, reopened.filled_base_lots as i64);
}

#[test]
fn a_partial_fill_is_completed_by_the_next_call() {
    let mut ctx = Ctx::new();
    let keys = ctx.ready_launch(SUPPLY, 30_000 * USDC);
    // enough collateral that the book, not the leverage cap, is the limit:
    // the fixture offers 40 SOL (4,000 lots) within the price bound
    ctx.fund_vault(&keys, 5_000 * USDC);
    let first = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert!(first.filled_base_lots > 0 && first.filled_base_lots < first.requested_base_lots);
    assert_eq!(ctx.perp(&keys).base_lots, first.filled_base_lots as i64);
    assert!(first.leverage_bps_after < 20_000);

    // leverage is still far under the minimum, so once there is liquidity the next call adds more
    ctx.replenish_book();
    let second = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(second.deposited, 0);
    assert!(second.increased && second.filled_base_lots > 0);
    assert_eq!(
        ctx.perp(&keys).base_lots,
        (first.filled_base_lots + second.filled_base_lots) as i64
    );
    assert!(second.leverage_bps_after <= 50_500);
}

#[test]
fn a_stale_mark_blocks_new_exposure() {
    let (mut ctx, keys) = funded();
    ctx.warp(151);
    assert_err(ctx.deploy(KEEPER, &keys), VaultError::StaleMarkPrice);
    assert_eq!(ctx.balance(&keys.vault_usdc), COLLATERAL);
    ctx.set_sol_price(SOL_PRICE);
    ok(ctx.deploy(KEEPER, &keys));
}

#[test]
fn nobody_can_deleverage_under_six_times() {
    let (mut ctx, keys) = levered();
    assert_err(
        ctx.deleverage("stranger", &keys),
        VaultError::NotDeleveragable,
    );
    // not even after an ordinary drift above 5x
    ctx.set_sol_price(146.0);
    let leverage = ctx.perp(&keys).leverage_bps();
    assert!(leverage > 50_500 && leverage < 60_000, "{leverage}");
    assert_err(
        ctx.deleverage("stranger", &keys),
        VaultError::NotDeleveragable,
    );
    assert_err(ctx.deleverage(KEEPER, &keys), VaultError::NotDeleveragable);
}

#[test]
fn above_six_times_anyone_cuts_the_position_to_five_and_a_half() {
    let (mut ctx, keys) = levered();
    // SOL falls 5%: a ~4.9x long is now above 6x
    ctx.set_sol_price(142.5);
    let before = ctx.perp(&keys);
    assert!(
        before.leverage_bps() > 60_000 && before.leverage_bps() < 70_000,
        "{}",
        before.leverage_bps()
    );

    // no keeper needed: this safety valve is open to anyone
    let reduced = event::<Deleveraged>(&ok(ctx.deleverage("stranger", &keys)));
    assert_eq!(reduced.filled_base_lots, reduced.requested_base_lots);
    // The program chose the size: what brings leverage to 5.5x at mark, short of the 5x target
    // so that less of the loss is realised. The fixture's resting bids sit above the new mark,
    // so the fill is better than mark and leverage lands a little lower.
    assert!(
        (45_000..=55_500).contains(&reduced.leverage_bps_after),
        "{}",
        reduced.leverage_bps_after
    );
    // it sold less than a cut all the way to 5x would have
    let to_target =
        before.base_lots as u64 * (before.leverage_bps() - 50_000) / before.leverage_bps();
    assert!(reduced.requested_base_lots < to_target);
    let after = ctx.perp(&keys);
    // the position is smaller, still open, and nothing was withdrawn
    assert!(after.base_lots > 0 && after.base_lots < before.base_lots);
    assert_eq!(ctx.balance(&keys.vault_usdc), 0);

    assert_err(
        ctx.deleverage("stranger", &keys),
        VaultError::NotDeleveragable,
    );
}

#[test]
fn margin_added_in_time_keeps_the_position_under_six_times() {
    let (mut ctx, keys) = levered();
    let base = ctx.perp(&keys).base_lots;
    // SOL falls 5%, which would put the position above 6x...
    ctx.set_sol_price(142.5);
    assert!(ctx.perp(&keys).leverage_bps() > 60_000);
    // ...but tax arrives first and goes in as margin, so there is nothing to deleverage
    ctx.fund_vault(&keys, 150 * USDC);
    let deployed = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert!(!deployed.increased);
    assert!(
        (47_500..60_000).contains(&deployed.leverage_bps_after),
        "{}",
        deployed.leverage_bps_after
    );
    assert_err(
        ctx.deleverage("stranger", &keys),
        VaultError::NotDeleveragable,
    );
    assert_eq!(ctx.perp(&keys).base_lots, base);
}

#[test]
fn an_account_about_to_be_liquidated_is_not_topped_up() {
    let (mut ctx, keys) = levered();
    ctx.set_sol_price(112.5);
    assert!(ctx.perp(&keys).is_liquidatable);
    // $20 would not bring a wiped-out account back; the deposit reverts and the tax waits
    // until the position is gone, after which the next deployment opens a new one
    ctx.fund_vault(&keys, 20 * USDC);
    assert_err(ctx.deploy(KEEPER, &keys), VaultError::AccountAtRisk);
    assert_eq!(ctx.balance(&keys.vault_usdc), 20 * USDC);
}

#[test]
fn pausing_blocks_deployment_but_never_deleveraging() {
    let (mut ctx, keys) = levered();
    ctx.fund_vault(&keys, 100 * USDC);
    ctx.set_paused(true);
    assert_err(ctx.deploy(KEEPER, &keys), VaultError::Paused);
    ctx.set_sol_price(138.0);
    ok(ctx.deleverage("stranger", &keys));
}
