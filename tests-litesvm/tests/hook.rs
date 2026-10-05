//! The transfer hook: transfers of a launched token maintain its vault's position, and a
//! transfer never fails because the vault had nothing to do.
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;
const COLLATERAL: u64 = 1_000 * USDC;

/// A hooked launch with no pool, an onboarded trader and two holders.
fn hooked() -> (Ctx, LaunchKeys, Pubkey) {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::hooked(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    // written empty at launch: without the list Token-2022 refuses every transfer
    ok(ctx.init_hook(&keys));
    ok(ctx.register_trader(&keys));
    ctx.onboard(&keys);
    let alice = ctx.user("alice", &keys.mint);
    let alice_tokens = ctx.token_ata(&alice, &keys.mint);
    (ctx, keys, alice_tokens)
}

/// The same, with the keeper's first deployment done and the hook's account list written.
fn armed() -> (Ctx, LaunchKeys, Pubkey) {
    let (mut ctx, keys, alice_tokens) = hooked();
    ctx.fund_vault(&keys, COLLATERAL);
    ok(ctx.deploy(KEEPER, &keys));
    ok(ctx.init_hook(&keys));
    (ctx, keys, alice_tokens)
}

fn max_depth(meta: &TransactionMetadata) -> u32 {
    meta.logs
        .iter()
        .filter_map(|line| {
            let at = line.find(" invoke [")?;
            line[at + 9..line.len() - 1].parse().ok()
        })
        .max()
        .unwrap_or(0)
}

#[test]
fn a_mint_may_only_carry_this_programs_hook_and_nobody_may_change_it() {
    let mut ctx = Ctx::new();
    // someone else's hook program
    let foreign = ctx.create_mint(MintOpts {
        hook: Some(mock_swap::ID),
        ..MintOpts::valid(SUPPLY)
    });
    assert_err(
        ctx.create_launch(foreign, default_args(SUPPLY)),
        VaultError::UnsupportedMintExtension,
    );
    // our hook, but with an authority that could swap it out later
    let changeable = ctx.create_mint(MintOpts {
        hook_authority: true,
        ..MintOpts::hooked(SUPPLY)
    });
    assert_err(
        ctx.create_launch(changeable, default_args(SUPPLY)),
        VaultError::UnsupportedMintExtension,
    );
    let mint = ctx.create_mint(MintOpts::hooked(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
}

#[test]
fn transfers_work_before_the_hook_is_set_up_and_do_nothing_to_the_vault() {
    let (mut ctx, keys, alice_tokens) = hooked();
    let meta = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 1_000 * TOKEN, false));
    assert!(events::<Deployed>(&meta).is_empty());
    assert_eq!(ctx.balance(&alice_tokens), 970 * TOKEN);
}

#[test]
fn a_transfer_tops_the_position_up_after_a_rally() {
    let (mut ctx, keys, alice_tokens) = armed();
    let opened = ctx.perp(&keys);

    // SOL rallies, leverage drifts under 4.75x, and nobody calls the keeper
    ctx.set_sol_price(156.0);
    ctx.warp(30);
    ctx.set_sol_price(156.0);
    assert!(ctx.perp(&keys).leverage_bps() < 47_500);

    // an ordinary transfer between two holders takes the position back to 5x
    let meta = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 1_000 * TOKEN, true));
    let deployed = event::<Deployed>(&meta);
    assert_eq!(deployed.deposited, 0);
    assert!(deployed.increased && deployed.filled_base_lots > 0);
    assert!(
        (48_000..=50_500).contains(&deployed.leverage_bps_after),
        "{}",
        deployed.leverage_bps_after
    );
    assert!(ctx.perp(&keys).base_lots > opened.base_lots);
    // the transfer itself is untouched: 3% withheld, the rest delivered
    assert_eq!(ctx.balance(&alice_tokens), 970 * TOKEN);
    // Token-2022 -> hook -> Hawkeye/Phoenix -> Phoenix: one level to spare under the runtime
    // limit of five, which a pool swap sent directly uses up
    assert!(max_depth(&meta) <= 4, "{}", max_depth(&meta));
    std::fs::write(
        "/tmp/terp-hook.txt",
        format!(
            "hook top-up inside a transfer: {} CU, max depth {}, {} hook accounts",
            meta.compute_units_consumed,
            max_depth(&meta),
            ctx.hook_accounts(&keys).len() - 2
        ),
    )
    .unwrap();
}

#[test]
fn idle_usdc_is_left_for_the_keeper() {
    let (mut ctx, keys, alice_tokens) = armed();
    // revenue reaches the vault (SIMULATED); depositing it needs more accounts than a transfer
    // can carry, so the hook leaves it for the keeper to deploy
    ctx.fund_vault(&keys, 200 * USDC);
    ctx.warp(30);
    ctx.set_sol_price(SOL_PRICE);
    ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 1_000 * TOKEN, true));
    assert_eq!(ctx.balance(&keys.vault_usdc), 200 * USDC);
    let deployed = event::<Deployed>(&ok(ctx.deploy(KEEPER, &keys)));
    assert_eq!(deployed.deposited, 200 * USDC);
}

#[test]
fn a_transfer_cuts_a_position_above_six_times() {
    let (mut ctx, keys, alice_tokens) = armed();
    ctx.set_sol_price(142.5);
    ctx.warp(30);
    ctx.set_sol_price(142.5);
    let before = ctx.perp(&keys);
    assert!(before.leverage_bps() > 60_000);

    let meta = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 1_000 * TOKEN, true));
    let cut = event::<Deleveraged>(&meta);
    assert!(cut.filled_base_lots > 0);
    assert!(
        cut.leverage_bps_after < 56_000,
        "{}",
        cut.leverage_bps_after
    );
    assert!(ctx.perp(&keys).base_lots < before.base_lots);
}

#[test]
fn a_transfer_goes_through_untouched_when_the_vault_has_nothing_to_do() {
    let (mut ctx, keys, alice_tokens) = armed();
    let position = ctx.perp(&keys).base_lots;
    ctx.warp(30);
    ctx.set_sol_price(SOL_PRICE);
    let meta = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 1_000 * TOKEN, true));
    assert!(events::<Deployed>(&meta).is_empty() && events::<Deleveraged>(&meta).is_empty());
    assert_eq!(ctx.perp(&keys).base_lots, position);
    assert_eq!(ctx.balance(&alice_tokens), 970 * TOKEN);
}

#[test]
fn a_transfer_never_fails_because_of_the_vault() {
    let (mut ctx, keys, alice_tokens) = armed();
    // leverage is under the minimum, so there is work to do
    ctx.set_sol_price(156.0);

    // the mark is stale: no order is placed, the transfer still goes through
    ctx.warp(200);
    let stale = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 100 * TOKEN, true));
    assert!(events::<Deployed>(&stale).is_empty());

    // the protocol is paused: the hook stands aside
    ctx.set_paused(true);
    ctx.warp(30);
    ctx.set_sol_price(156.0);
    let paused = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 101 * TOKEN, true));
    assert!(events::<Deployed>(&paused).is_empty());
    ctx.set_paused(false);

    // the account is about to be liquidated: nothing is added, the transfer goes through
    ctx.set_sol_price(112.5);
    ctx.warp(30);
    ctx.set_sol_price(112.5);
    assert!(ctx.perp(&keys).is_liquidatable);
    ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 102 * TOKEN, true));
}

#[test]
fn the_hook_stands_aside_without_enough_compute() {
    let (mut ctx, keys, alice_tokens) = armed();
    ctx.set_sol_price(156.0);
    ctx.warp(30);
    ctx.set_sol_price(156.0);
    // a transaction that did not budget for the rebalance: the transfer goes through without it
    let lean =
        ok(ctx.transfer_hooked_with_budget(CREATOR, &keys, &alice_tokens, 100 * TOKEN, 400_000));
    assert!(events::<Deployed>(&lean).is_empty());
    assert_eq!(ctx.balance(&alice_tokens), 97 * TOKEN);
}

#[test]
fn the_hook_looks_at_the_position_at_most_once_per_interval() {
    let (mut ctx, keys, alice_tokens) = armed();
    ctx.warp(30);
    ctx.set_sol_price(SOL_PRICE);
    let first = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 100 * TOKEN, true));
    // the price moves right after; the next transfer in the same window does not look again
    ctx.set_sol_price(156.0);
    let second = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 101 * TOKEN, true));
    assert!(events::<Deployed>(&second).is_empty());
    assert!(second.compute_units_consumed < first.compute_units_consumed);
    // once the window has passed, a transfer does
    ctx.warp(30);
    ctx.set_sol_price(156.0);
    let third = ok(ctx.transfer_hooked(CREATOR, &keys, &alice_tokens, 102 * TOKEN, true));
    assert!(event::<Deployed>(&third).increased);
}

#[test]
fn the_hook_cannot_be_called_outside_a_transfer() {
    let (mut ctx, keys, alice_tokens) = armed();
    let position = ctx.perp(&keys).base_lots;
    ctx.set_sol_price(156.0);
    ctx.warp(30);
    ctx.set_sol_price(156.0);
    assert_err(
        ctx.call_hook_directly(CREATOR, &keys, &alice_tokens),
        VaultError::NotTransferring,
    );
    assert_eq!(ctx.perp(&keys).base_lots, position);
}
