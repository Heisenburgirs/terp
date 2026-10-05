//! One launch from creation to a redemption, against the real Phoenix programs.
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;
const POOL_USDC: u64 = 30_000 * USDC;

#[test]
fn one_keeper_transaction_turns_tax_into_a_position_and_a_holder_redeems_in_one() {
    let mut ctx = Ctx::new();
    let keys = ctx.ready_launch(SUPPLY, POOL_USDC);

    // Trading activity: the creator sends 100k tokens to Alice. 3% is withheld on her account,
    // and 3% of the pool seed was withheld on the pool's account.
    let alice = ctx.user("alice", &keys.mint);
    let alice_tokens = ctx.token_ata(&alice, &keys.mint);
    ok(ctx.transfer(CREATOR, &keys.mint, &alice_tokens, 100_000 * TOKEN));
    assert_eq!(ctx.balance(&alice_tokens), 97_000 * TOKEN);

    // The keeper sweeps the tax into the vault, sells it in the token's own pool and deploys the
    // proceeds on Phoenix, all in ONE transaction.
    let pool_paid = ctx.pool_quote(&keys, 18_000 * TOKEN);
    let meta = ok(ctx.collect_convert_deploy(
        &keys,
        &[alice_tokens, keys.pool_token_vault],
        18_000 * TOKEN,
    ));
    let collected = event::<TaxCollected>(&meta);
    let converted = event::<TaxConverted>(&meta);
    let deployed = event::<Deployed>(&meta);

    // collect: withheld tokens moved to the vault's tax account; nothing minted or burned
    assert_eq!(collected.tokens, 18_000 * TOKEN);
    assert_eq!(ctx.supply(&keys.mint), SUPPLY);
    // convert: the platform's 3% keeper fee went to the treasury, the rest to the vault; the
    // keeper key itself received nothing
    let fee = keeper_fee(pool_paid);
    let revenue = pool_paid - fee;
    assert_eq!(converted.tokens_in, 18_000 * TOKEN);
    assert_eq!((converted.usdc_out, converted.keeper_fee), (pool_paid, fee));
    assert_eq!(ctx.balance(&ctx.usdc_ata(&ctx.treasury)), fee);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&ctx.keeper)), 0);
    // deploy: all of the vault's share became collateral, and a 5x long was opened against it
    assert_eq!(deployed.deposited, revenue);
    assert!(deployed.increased);
    assert_eq!(deployed.filled_base_lots, deployed.requested_base_lots);
    assert!(
        (48_000..=50_500).contains(&deployed.leverage_bps_after),
        "{}",
        deployed.leverage_bps_after
    );
    assert_eq!(ctx.balance(&keys.vault_usdc), 0);
    assert_eq!(ctx.balance(&keys.tax_account), 0);
    let perp = ctx.perp(&keys);
    assert_eq!(perp.base_lots, deployed.filled_base_lots as i64);
    let launch = ctx.launch(&keys);
    assert_eq!(launch.usdc_converted, revenue);
    assert_eq!(launch.keeper_fees_paid, fee);
    assert_eq!(launch.usdc_deposited, revenue);

    // Alice burns 50k tokens. The vault is fully deployed, so her own transaction closes her
    // share of the position, withdraws her share of collateral, and pays her.
    ctx.settle_clock();
    let preview = ctx.preview(&keys, 50_000 * TOKEN);
    let equity = ctx.equity(&keys);
    let redeemed = event::<Redeemed>(&ok(ctx.redeem(
        "alice",
        &keys,
        50_000 * TOKEN,
        preview.payout * 98 / 100,
    )));
    assert_eq!(redeemed.equity, equity);
    assert_eq!(redeemed.supply_before, SUPPLY);
    assert_eq!(
        (redeemed.gross, redeemed.redemption_fee),
        (preview.gross, preview.redemption_fee)
    );
    assert_eq!(
        redeemed.payout,
        redeemed.gross - redeemed.redemption_fee - redeemed.exit_cost
    );
    assert_eq!((redeemed.paid, redeemed.owed), (redeemed.payout, 0));
    assert!(redeemed.base_lots_closed > 0);

    // the tokens were burned, not transferred: supply fell by exactly q and Alice got USDC
    assert_eq!(ctx.supply(&keys.mint), SUPPLY - 50_000 * TOKEN);
    assert_eq!(ctx.balance(&alice_tokens), 47_000 * TOKEN);
    assert_eq!(ctx.balance(&ctx.usdc_ata(&alice)), redeemed.payout);
    assert!(ctx.claim(&keys, &alice).is_none());

    // the retained fee raised backing per remaining token
    let equity_after = ctx.equity(&keys);
    assert!(
        equity_after as u128 * SUPPLY as u128 > equity as u128 * (SUPPLY - 50_000 * TOKEN) as u128,
        "backing per token must rise"
    );
    // and her exit did not lever up the holders who stayed
    assert!(ctx.perp(&keys).leverage_bps() <= perp.leverage_bps().max(50_000) * 101 / 100);
}
