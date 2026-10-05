//! `rebalance`: the open instruction that keeps a position in its leverage band. Terp's site
//! attaches it to users' trades, so it must do the right thing when there is work and must never
//! fail the transaction it travels in when there is none.
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;
const COLLATERAL: u64 = 1_000 * USDC;

/// A vault with a ~4.9x long, a holder, and another wallet.
fn levered() -> (Ctx, LaunchKeys, Pubkey) {
    let mut ctx = Ctx::new();
    let keys = ctx.levered_launch(SUPPLY, COLLATERAL);
    let alice = ctx.user("alice", &keys.mint);
    let alice_tokens = ctx.token_ata(&alice, &keys.mint);
    ctx.user("stranger", &keys.mint);
    (ctx, keys, alice_tokens)
}

#[test]
fn anyone_can_top_the_position_up_after_a_rally() {
    let (mut ctx, keys, _) = levered();
    let opened = ctx.perp(&keys);
    ctx.set_sol_price(156.0);
    assert!(ctx.perp(&keys).leverage_bps() < 47_500);

    let deployed = event::<Deployed>(&ok(ctx.rebalance("stranger", &keys)));
    assert_eq!(deployed.deposited, 0);
    assert!(deployed.increased && deployed.filled_base_lots > 0);
    assert!(
        (48_000..=50_500).contains(&deployed.leverage_bps_after),
        "{}",
        deployed.leverage_bps_after
    );
    assert!(ctx.perp(&keys).base_lots > opened.base_lots);
}

#[test]
fn anyone_can_put_idle_usdc_to_work() {
    let (mut ctx, keys, _) = levered();
    // revenue reaches the vault (SIMULATED)
    ctx.fund_vault(&keys, 300 * USDC);
    let bob = ctx.user("bob", &keys.mint);
    let deployed = event::<Deployed>(&ok(ctx.rebalance("bob", &keys)));
    // the caller received nothing and chose nothing
    assert_eq!(ctx.balance(&ctx.usdc_ata(&bob)), 0);
    assert_eq!(deployed.deposited, 300 * USDC);
    assert_eq!(ctx.balance(&keys.vault_usdc), 0);
    assert!(deployed.leverage_bps_after <= 50_500);
}

#[test]
fn anyone_can_cut_a_position_above_six_times() {
    let (mut ctx, keys, _) = levered();
    ctx.set_sol_price(142.5);
    let before = ctx.perp(&keys);
    assert!(before.leverage_bps() > 60_000);

    let cut = event::<Deleveraged>(&ok(ctx.rebalance("stranger", &keys)));
    assert!(cut.filled_base_lots > 0);
    assert!(
        cut.leverage_bps_after < 56_000,
        "{}",
        cut.leverage_bps_after
    );
    assert!(ctx.perp(&keys).base_lots < before.base_lots);
}

#[test]
fn it_succeeds_and_does_nothing_when_there_is_no_work() {
    let (mut ctx, keys, _) = levered();
    let position = ctx.perp(&keys).base_lots;
    let meta = ok(ctx.rebalance("stranger", &keys));
    assert!(events::<Deployed>(&meta).is_empty() && events::<Deleveraged>(&meta).is_empty());
    assert_eq!(ctx.perp(&keys).base_lots, position);
}

#[test]
fn it_never_fails_the_transaction_it_travels_in() {
    let (mut ctx, keys, alice_tokens) = levered();
    ctx.set_sol_price(156.0);

    // a stale mark: no order is placed, and the user's transfer in the same transaction lands
    ctx.warp(200);
    let stale = ok(ctx.transfer_with_rebalance(CREATOR, &keys, &alice_tokens, 100 * TOKEN));
    assert!(events::<Deployed>(&stale).is_empty());
    assert_eq!(ctx.balance(&alice_tokens), 97 * TOKEN);

    // paused: deposits and new exposure are off, the transfer still lands
    ctx.set_sol_price(156.0);
    ctx.fund_vault(&keys, 100 * USDC);
    ctx.set_paused(true);
    let paused = ok(ctx.transfer_with_rebalance(CREATOR, &keys, &alice_tokens, 100 * TOKEN));
    assert!(events::<Deployed>(&paused).is_empty());
    assert_eq!(ctx.balance(&keys.vault_usdc), 100 * USDC);
    ctx.set_paused(false);

    // an account about to be liquidated is not topped up; the transfer still lands
    ctx.set_sol_price(112.5);
    assert!(ctx.perp(&keys).is_liquidatable);
    ok(ctx.transfer_with_rebalance(CREATOR, &keys, &alice_tokens, 100 * TOKEN));
    assert_eq!(ctx.balance(&alice_tokens), 291 * TOKEN);
}

#[test]
fn a_cut_still_works_while_paused() {
    let (mut ctx, keys, _) = levered();
    ctx.set_paused(true);
    ctx.set_sol_price(142.5);
    let cut = event::<Deleveraged>(&ok(ctx.rebalance("stranger", &keys)));
    assert!(cut.filled_base_lots > 0);
}

#[test]
fn it_waits_until_phoenix_has_enabled_the_trader_account() {
    let mut ctx = Ctx::new();
    let keys = ctx.launch_with_pool(SUPPLY, 30_000 * USDC);
    ctx.user("stranger", &keys.mint);
    ctx.fund_vault(&keys, COLLATERAL);
    // no trader account yet: nothing to do, and no failure
    ok(ctx.rebalance("stranger", &keys));
    assert_eq!(ctx.balance(&keys.vault_usdc), COLLATERAL);
    ok(ctx.register_trader(&keys));

    // once Phoenix enables it, any wallet opens the position; no keeper is involved
    ctx.onboard(&keys);
    let opened = event::<Deployed>(&ok(ctx.rebalance("stranger", &keys)));
    assert_eq!(opened.deposited, COLLATERAL);
    assert!(opened.increased && opened.leverage_bps_after <= 50_500);
}

#[test]
fn a_trade_and_a_rebalance_fit_in_one_transaction() {
    let (mut ctx, keys, alice_tokens) = levered();
    ctx.set_sol_price(156.0);
    let meta = ok(ctx.transfer_with_rebalance(CREATOR, &keys, &alice_tokens, 1_000 * TOKEN));
    assert!(event::<Deployed>(&meta).increased);
    assert_eq!(ctx.balance(&alice_tokens), 970 * TOKEN);
}
