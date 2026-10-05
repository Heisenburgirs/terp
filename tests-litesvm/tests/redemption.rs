//! Redemption accounting and its adversarial cases. A redemption is one transaction by the
//! holder; nobody else has to act for it to complete.
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;
const COLLATERAL: u64 = 1_000 * USDC;

/// A levered launch and two holders: Alice with 97k tokens, Bob with 48.5k.
fn setup() -> (Ctx, LaunchKeys, Pubkey, Pubkey) {
    let mut ctx = Ctx::new();
    let keys = ctx.levered_launch(SUPPLY, COLLATERAL);
    let alice = ctx.user("alice", &keys.mint);
    let bob = ctx.user("bob", &keys.mint);
    let alice_tokens = ctx.token_ata(&alice, &keys.mint);
    let bob_tokens = ctx.token_ata(&bob, &keys.mint);
    ok(ctx.transfer(CREATOR, &keys.mint, &alice_tokens, 100_000 * TOKEN));
    ok(ctx.transfer(CREATOR, &keys.mint, &bob_tokens, 50_000 * TOKEN));
    (ctx, keys, alice, bob)
}

fn backing_per_token(ctx: &mut Ctx, keys: &LaunchKeys) -> u128 {
    ctx.equity(keys) as u128 * 1_000_000_000_000 / ctx.supply(&keys.mint) as u128
}

#[test]
fn one_transaction_burns_and_pays_with_no_transfer_fee_and_no_cost_to_other_holders() {
    let (mut ctx, keys, alice, _) = setup();
    let alice_tokens = ctx.token_ata(&alice, &keys.mint);
    let amount = 50_000 * TOKEN;
    let preview = ctx.preview(&keys, amount);
    let equity_before = ctx.equity(&keys);
    let backing_before = backing_per_token(&mut ctx, &keys);
    let leverage_before = ctx.perp(&keys).leverage_bps();

    let redeemed = event::<Redeemed>(&ok(ctx.redeem(
        "alice",
        &keys,
        amount,
        preview.payout * 98 / 100,
    )));
    assert_eq!(
        (redeemed.gross, redeemed.redemption_fee),
        (preview.gross, preview.redemption_fee)
    );
    assert_eq!((redeemed.paid, redeemed.owed), (redeemed.payout, 0));
    // exactly q left her account and the supply: a burn, with no 3% taken on the way
    assert_eq!(ctx.balance(&alice_tokens), 97_000 * TOKEN - amount);
    assert_eq!(ctx.supply(&keys.mint), SUPPLY - amount);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&alice)), redeemed.payout);

    // full effective charge: the 3% fee plus the exit cost, nothing hidden
    assert_eq!(
        redeemed.payout,
        redeemed.gross - redeemed.redemption_fee - redeemed.exit_cost
    );
    assert_eq!(
        redeemed.redemption_fee,
        (redeemed.gross as u128 * 300).div_ceil(10_000) as u64
    );
    // the exit cost is what closing her slice really cost, never less than the flat estimate
    // (the fixture's book is 0.33% wide, far wider than SOL on mainnet)
    assert!(
        redeemed.exit_cost >= preview.exit_cost && redeemed.exit_cost < redeemed.gross * 3 / 100
    );

    // the vault was fully deployed, so her share of the position was closed and her share of
    // collateral withdrawn, inside her own transaction
    assert!(redeemed.base_lots_closed > 0);
    assert_eq!(redeemed.usdc_withdrawn, redeemed.payout);
    assert_eq!(ctx.balance(&keys.vault_usdc), 0);
    assert!(ctx.perp(&keys).leverage_bps() <= leverage_before.max(50_000) * 101 / 100);

    // The holders who stayed paid nothing for her exit. Her gross share left their equity, the
    // 3% fee stayed with them, and the cost of closing her slice came out of her payout.
    let equity_after = ctx.equity(&keys);
    assert!(
        equity_after >= equity_before - redeemed.gross + redeemed.redemption_fee,
        "{equity_after} {equity_before}"
    );
    assert!(equity_after <= equity_before - redeemed.payout);
    assert!(backing_per_token(&mut ctx, &keys) > backing_before);
    let launch = ctx.launch(&keys);
    assert_eq!(launch.redemption_fees_retained, redeemed.redemption_fee);
    assert_eq!(launch.exit_costs_retained, redeemed.exit_cost);
    assert_eq!(launch.usdc_redeemed, redeemed.payout);
    assert_eq!(launch.pending_claims, 0);
    assert!(ctx.claim(&keys, &alice).is_none());
}

#[test]
fn amounts_below_the_minimum_or_above_the_balance_are_refused() {
    let (mut ctx, keys, _, _) = setup();
    assert_err(
        ctx.redeem("alice", &keys, TOKEN - 1, 0),
        VaultError::RedemptionTooSmall,
    );
    assert_err(
        ctx.redeem("alice", &keys, 97_001 * TOKEN, 0),
        VaultError::RedemptionTooSmall,
    );
}

#[test]
fn the_minimum_payout_is_enforced_at_the_moment_of_redemption() {
    let (mut ctx, keys, alice, _) = setup();
    let amount = 50_000 * TOKEN;
    let quoted = ctx.preview(&keys, amount).payout;

    // SOL drops 3% between the quote and the transaction: vault equity falls ~15%
    ctx.set_sol_price(145.5);
    assert!(ctx.preview(&keys, amount).payout < quoted * 99 / 100);
    assert_err(
        ctx.redeem("alice", &keys, amount, quoted * 99 / 100),
        VaultError::PayoutBelowMinimum,
    );

    // nothing was burned, sold or paid
    assert_eq!(ctx.supply(&keys.mint), SUPPLY);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&alice)), 0);
    assert_eq!(
        ctx.balance(&ctx.token_ata(&alice, &keys.mint)),
        97_000 * TOKEN
    );

    // she accepts the new price and it goes through
    let now = ctx.preview(&keys, amount).payout;
    let redeemed = event::<Redeemed>(&ok(ctx.redeem("alice", &keys, amount, now * 98 / 100)));
    assert!(redeemed.payout >= now * 98 / 100 && redeemed.payout <= now);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&alice)), redeemed.payout);
}

#[test]
fn idle_usdc_is_used_before_the_position_is_touched() {
    let (mut ctx, keys, alice, _) = setup();
    ctx.fund_vault(&keys, 500 * USDC);
    let base = ctx.perp(&keys).base_lots;
    let expected = ctx.preview(&keys, 10_000 * TOKEN);
    assert!(expected.payout < 500 * USDC);

    let redeemed = event::<Redeemed>(&ok(ctx.redeem(
        "alice",
        &keys,
        10_000 * TOKEN,
        expected.payout,
    )));
    assert_eq!(redeemed.base_lots_closed, 0);
    assert_eq!(redeemed.usdc_withdrawn, 0);
    assert_eq!(ctx.perp(&keys).base_lots, base);
    assert_eq!(ctx.balance(&keys.vault_usdc), 500 * USDC - expected.payout);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&alice)), expected.payout);
}

#[test]
fn tokens_cannot_be_redeemed_twice() {
    let (mut ctx, keys, alice, _) = setup();
    // Alice holds 97k and redeems 60k
    ok(ctx.redeem("alice", &keys, 60_000 * TOKEN, 1));
    let paid = ctx.balance(&ctx.usdc_ata(&alice));
    // the 60k are gone; she cannot redeem them again
    assert_err(
        ctx.redeem("alice", &keys, 60_000 * TOKEN, 1),
        VaultError::RedemptionTooSmall,
    );
    assert_eq!(ctx.balance(&ctx.usdc_ata(&alice)), paid);
    assert_eq!(ctx.supply(&keys.mint), SUPPLY - 60_000 * TOKEN);
}

#[test]
fn back_to_back_redemptions_each_use_the_supply_and_equity_of_their_own_moment() {
    let (mut ctx, keys, _, _) = setup();
    let (qa, qb) = (40_000 * TOKEN, 20_000 * TOKEN);
    let equity_0 = ctx.equity(&keys);

    let first = event::<Redeemed>(&ok(ctx.redeem("bob", &keys, qb, 1)));
    assert_eq!(first.supply_before, SUPPLY);
    assert_eq!(first.equity, equity_0);

    let equity_1 = ctx.equity(&keys);
    let second = event::<Redeemed>(&ok(ctx.redeem("alice", &keys, qa, 1)));
    assert_eq!(second.supply_before, SUPPLY - qb);
    assert_eq!(second.equity, equity_1);
    assert_eq!(
        second.gross,
        (qa as u128 * equity_1 as u128 / (SUPPLY - qb) as u128) as u64
    );

    // conservation: each redeemer's gross share left, both fees stayed, and each paid for
    // their own exit out of their own payout
    let equity_2 = ctx.equity(&keys);
    let paid = first.payout + second.payout;
    let gross_less_fees = first.gross - first.redemption_fee + second.gross - second.redemption_fee;
    assert!(equity_2 >= equity_0 - gross_less_fees);
    assert!(equity_2 <= equity_0 - paid);
    assert_eq!(ctx.supply(&keys.mint), SUPPLY - qa - qb);
    // together they got less than their fee-free pro-rata share
    assert!(paid as u128 * (SUPPLY as u128) < (qa + qb) as u128 * equity_0 as u128);
    // and backing per remaining token ended higher than it started
    assert!(equity_2 as u128 * SUPPLY as u128 > equity_0 as u128 * (SUPPLY - qa - qb) as u128);
}

#[test]
fn a_stale_mark_blocks_redemption_while_a_position_is_open() {
    let (mut ctx, keys, _, _) = setup();
    // an open position is valued at mark; a mark older than 150 slots is not accepted
    ctx.warp(151);
    assert_err(
        ctx.redeem("alice", &keys, 20_000 * TOKEN, 1),
        VaultError::StaleMarkPrice,
    );
    assert_eq!(ctx.supply(&keys.mint), SUPPLY);

    ctx.set_sol_price(SOL_PRICE);
    ok(ctx.redeem("alice", &keys, 20_000 * TOKEN, 1));
}

#[test]
fn losses_reduce_redemption_value_and_a_wiped_out_position_backs_nothing() {
    let (mut ctx, keys, _, _) = setup();
    // 200 USDC of fresh tax revenue is sitting idle in the vault
    ctx.fund_vault(&keys, 200 * USDC);
    let healthy = ctx.equity(&keys);

    // SOL falls 25%: a ~4.95x long has lost more than its collateral
    ctx.set_sol_price(112.5);
    let perp = ctx.perp(&keys);
    assert!(perp.equity() < 0, "{perp:?}");
    assert!(perp.is_liquidatable);

    // the underwater account counts as zero, not negative: only idle USDC backs the token
    let equity = ctx.equity(&keys);
    assert_eq!(equity, 200 * USDC);
    assert!(equity < healthy / 5);

    let amount = 50_000 * TOKEN;
    let preview = ctx.preview(&keys, amount);
    let redeemed = event::<Redeemed>(&ok(ctx.redeem("alice", &keys, amount, 1)));
    assert_eq!(redeemed.payout, preview.payout);
    assert_eq!(redeemed.gross, 10 * USDC); // 5% of 200 USDC
    assert!(redeemed.payout < 10 * USDC);
    // the idle USDC was not drained by the first redeemer
    assert_eq!(ctx.balance(&keys.vault_usdc), 200 * USDC - redeemed.payout);
}

/// Bob's redemption hits Phoenix's exchange-wide withdraw throttle and is queued.
fn queued() -> (Ctx, LaunchKeys, Pubkey, Pubkey, Redeemed) {
    let (mut ctx, keys, alice, bob) = setup();
    // room for Alice's withdrawal but not for Bob's after it, and no refill
    ctx.set_withdraw_budget(60 * USDC, 0);
    let first = event::<Redeemed>(&ok(ctx.redeem("alice", &keys, 50_000 * TOKEN, 1)));
    assert_eq!(first.owed, 0);

    let expected = ctx.preview(&keys, 40_000 * TOKEN);
    let min = expected.payout * 98 / 100;
    let queued = event::<Redeemed>(&ok(ctx.redeem("bob", &keys, 40_000 * TOKEN, min)));
    assert!(queued.payout >= min);
    (ctx, keys, alice, bob, queued)
}

#[test]
fn a_queued_withdrawal_becomes_a_fixed_claim_that_anyone_can_pay_out() {
    let (mut ctx, keys, _, bob, redeemed) = queued();
    let stranger = ctx.user("stranger", &keys.mint);
    let _ = stranger;

    // Bob's tokens are burned and his share of the position is closed; the USDC is on its way
    assert_eq!(redeemed.paid, 0);
    assert_eq!(redeemed.owed, redeemed.payout);
    assert!(redeemed.base_lots_closed > 0);
    assert_eq!(ctx.balance(&ctx.token_ata(&bob, &keys.mint)), 8_500 * TOKEN);
    assert_eq!(ctx.supply(&keys.mint), SUPPLY - 90_000 * TOKEN);
    assert!(ctx.has_queued_withdrawal(&keys));
    assert_eq!(ctx.claim(&keys, &bob).unwrap().amount, redeemed.payout);
    assert_eq!(ctx.launch(&keys).pending_claims, redeemed.payout);

    // the claim is not anyone else's equity: E is net of it
    assert_eq!(ctx.equity(&keys), ctx.assets(&keys) - redeemed.payout);
    // there is nothing to pay it with yet, and a second withdrawal cannot be stacked behind it
    assert_err(
        ctx.pay_claim("stranger", &keys, &bob),
        VaultError::NothingToPay,
    );
    assert_err(
        ctx.redeem("alice", &keys, 20_000 * TOKEN, 1),
        VaultError::WithdrawalAlreadyQueued,
    );

    // SIMULATED: Phoenix pays the queued withdrawal into the vault's canonical account
    ctx.pay_queued_withdrawal(&keys, redeemed.payout);
    ok(ctx.unwrap_canonical("stranger", &keys));
    assert_eq!(ctx.balance(&keys.vault_usdc), redeemed.payout);

    // that USDC is reserved for Bob: it cannot be redeployed as collateral
    assert_err(ctx.deploy(KEEPER, &keys), VaultError::NothingToDeploy);

    // anyone pays the claim; the money can only go to Bob
    let paid = event::<ClaimPaid>(&ok(ctx.pay_claim("stranger", &keys, &bob)));
    assert_eq!((paid.usdc, paid.remaining), (redeemed.payout, 0));
    assert_eq!(ctx.balance(&ctx.usdc_ata(&bob)), redeemed.payout);
    assert_eq!(ctx.balance(&keys.vault_usdc), 0);
    assert_eq!(ctx.launch(&keys).pending_claims, 0);
    assert!(ctx.claim(&keys, &bob).is_none());
}

#[test]
fn the_value_of_a_claim_is_fixed_when_the_tokens_are_burned() {
    let (mut ctx, keys, _, bob, redeemed) = queued();
    // the market moves against the vault after Bob redeemed
    ctx.set_sol_price(147.0);
    assert_eq!(ctx.claim(&keys, &bob).unwrap().amount, redeemed.payout);
    // remaining holders carry that move, on equity that excludes his claim
    let equity = ctx.equity(&keys);
    assert_eq!(equity, ctx.assets(&keys) - redeemed.payout);
}

#[test]
fn if_phoenix_drops_the_queued_withdrawal_anyone_can_request_it_again() {
    let (mut ctx, keys, _, bob, redeemed) = queued();
    ctx.user("stranger", &keys.mint);
    // while it is queued there is nothing to re-request
    assert_err(
        ctx.fund_claims("stranger", &keys),
        VaultError::WithdrawalAlreadyQueued,
    );

    // SIMULATED: Phoenix dropped the queued withdrawal (the trader's queue slot is cleared and
    // nothing was paid). The fixture cannot run Phoenix's queue crank, so the exchange queue
    // itself still holds the old entry and the new request waits behind it.
    let mut account = ctx.px.svm.get_account(&keys.trader_account).unwrap();
    account.data[108..112].copy_from_slice(&0u32.to_le_bytes());
    ctx.px
        .svm
        .set_account(keys.trader_account, account)
        .unwrap();
    assert!(!ctx.has_queued_withdrawal(&keys));

    // anyone asks Phoenix again, for exactly what is owed and no more
    let base = ctx.perp(&keys).base_lots;
    let funded = event::<ClaimsFunded>(&ok(ctx.fund_claims("stranger", &keys)));
    assert_eq!(funded.requested, redeemed.payout);
    assert!(ctx.has_queued_withdrawal(&keys));
    // it moves collateral only: Bob's share of the position was closed when he redeemed
    assert_eq!(ctx.perp(&keys).base_lots, base);

    // SIMULATED: Phoenix pays; anyone forwards it to Bob
    ctx.pay_queued_withdrawal(&keys, redeemed.payout);
    ok(ctx.unwrap_canonical("stranger", &keys));
    assert_err(ctx.fund_claims("stranger", &keys), VaultError::NothingToPay);
    ok(ctx.pay_claim("stranger", &keys, &bob));
    assert_eq!(ctx.balance(&ctx.usdc_ata(&bob)), redeemed.payout);
    assert_eq!(ctx.launch(&keys).pending_claims, 0);
}

#[test]
fn an_unlevered_vault_redeems_from_idle_usdc_alone() {
    let mut ctx = Ctx::new();
    // no Phoenix trader at all
    let keys = ctx.launch_with_pool(SUPPLY, 30_000 * USDC);
    ctx.fund_vault(&keys, 500 * USDC);
    let alice = ctx.user("alice", &keys.mint);
    ok(ctx.transfer(
        CREATOR,
        &keys.mint,
        &ctx.token_ata(&alice, &keys.mint),
        100_000 * TOKEN,
    ));

    let redeemed = event::<Redeemed>(&ok(ctx.redeem("alice", &keys, 50_000 * TOKEN, 1)));
    assert_eq!(redeemed.equity, 500 * USDC);
    assert_eq!(redeemed.notional, 0);
    assert_eq!(redeemed.gross, 25 * USDC);
    assert_eq!(redeemed.redemption_fee, 750_000);
    assert_eq!(redeemed.exit_cost, 0);
    assert_eq!(redeemed.payout, 24_250_000);
    assert_eq!(redeemed.paid, 24_250_000);
}

#[test]
fn the_last_holder_takes_everything_and_later_dust_goes_to_the_treasury() {
    let mut ctx = Ctx::new();
    // no pool and no transfers: the creator holds the entire supply
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    ctx.fund_vault(&keys, 1_234_567);
    let creator = ctx.creator;

    assert_err(ctx.sweep_residual(&keys), VaultError::SupplyNotZero);

    // redeem all but one token: normal fee
    let most = event::<Redeemed>(&ok(ctx.redeem(CREATOR, &keys, SUPPLY - TOKEN, 1)));
    assert!(most.redemption_fee > 0);
    let left = ctx.balance(&keys.vault_usdc);
    assert_eq!(left, 1_234_567 - most.payout);

    // the final token: no fee, the vault empties to the last atom
    let last = event::<Redeemed>(&ok(ctx.redeem(CREATOR, &keys, TOKEN, 1)));
    assert_eq!(last.supply_before, TOKEN);
    assert_eq!(last.redemption_fee, 0);
    assert_eq!(last.payout, left);
    assert_eq!(ctx.supply(&mint), 0);
    assert_eq!(ctx.balance(&keys.vault_usdc), 0);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&creator)), 1_234_567);

    // USDC that reaches the vault after supply is zero has no owner left
    ctx.fund_vault(&keys, 42);
    let swept = event::<ResidualSwept>(&ok(ctx.sweep_residual(&keys)));
    assert_eq!(swept.usdc, 42);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&ctx.treasury)), 42);
}

#[test]
fn the_final_redemption_closes_the_whole_position_and_empties_phoenix() {
    let mut ctx = Ctx::new();
    // the creator holds the entire supply of a levered vault
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    ok(ctx.register_trader(&keys));
    ctx.onboard(&keys);
    ctx.lever(&keys, COLLATERAL);
    let creator = ctx.creator;
    let base = ctx.perp(&keys).base_lots as u64;

    let last = event::<Redeemed>(&ok(ctx.redeem(CREATOR, &keys, SUPPLY, 1)));
    assert_eq!(last.base_lots_closed, base);
    assert_eq!(last.redemption_fee, 0);
    assert_eq!(last.paid, last.payout);
    // round trip cost: taker fees and spread, no more
    assert!(last.payout > COLLATERAL * 96 / 100 && last.payout < COLLATERAL);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&creator)), last.payout);

    assert_eq!(ctx.supply(&mint), 0);
    let flat = ctx.perp(&keys);
    assert_eq!((flat.base_lots, flat.collateral), (0, 0));
    assert_eq!(ctx.balance(&keys.vault_usdc), 0);
}
