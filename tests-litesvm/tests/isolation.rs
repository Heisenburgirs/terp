//! One launch's losses and one launch's accounts never reach another launch, and no key has a
//! privileged path to any vault.
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;

#[test]
fn each_launch_has_its_own_trader_account_and_vault() {
    let mut ctx = Ctx::new();
    let a = ctx.ready_launch(SUPPLY, 30_000 * USDC);
    let b = ctx.ready_launch(SUPPLY, 30_000 * USDC);
    assert_ne!(a.launch, b.launch);
    assert_ne!(a.trader_account, b.trader_account);
    assert_ne!(a.vault_usdc, b.vault_usdc);
    assert_ne!(a.tax_account, b.tax_account);
}

#[test]
fn a_wiped_out_launch_does_not_touch_its_neighbour() {
    let mut ctx = Ctx::new();
    // A runs a ~4.95x long; B holds only idle USDC
    let a = ctx.levered_launch(SUPPLY, 1_000 * USDC);
    let b = ctx.launch_with_pool(SUPPLY, 30_000 * USDC);
    ctx.fund_vault(&b, 1_300 * USDC);
    assert_eq!(ctx.equity(&b), 1_300 * USDC);

    // SOL falls 25%: A's account is underwater
    ctx.set_sol_price(112.5);
    assert!(ctx.perp(&a).equity() < 0);
    assert_eq!(ctx.equity(&a), 0);

    // B is exactly where it was, and B's holders redeem against B's equity alone
    assert_eq!(ctx.equity(&b), 1_300 * USDC);
    let holder = ctx.user("holder", &b.mint);
    ok(ctx.transfer(
        CREATOR,
        &b.mint,
        &ctx.token_ata(&holder, &b.mint),
        100_000 * TOKEN,
    ));
    let redeemed = event::<Redeemed>(&ok(ctx.redeem("holder", &b, 50_000 * TOKEN, 1)));
    assert_eq!(redeemed.equity, 1_300 * USDC);
    assert_eq!(redeemed.gross, 65 * USDC);
}

#[test]
fn one_launch_cannot_operate_on_another_launchs_phoenix_account_or_vault() {
    let mut ctx = Ctx::new();
    let a = ctx.levered_launch(SUPPLY, 1_000 * USDC);
    let b = ctx.levered_launch(SUPPLY, 1_000 * USDC);
    ctx.fund_vault(&a, 100 * USDC);
    let alice = ctx.user("alice", &a.mint);
    ok(ctx.transfer(
        CREATOR,
        &a.mint,
        &ctx.token_ata(&alice, &a.mint),
        100_000 * TOKEN,
    ));

    // launch A's deployment pointed at launch B's trader account
    let mut crossed = a;
    crossed.trader_account = b.trader_account;
    assert_err(
        ctx.deploy(KEEPER, &crossed),
        VaultError::InvalidPhoenixAccount,
    );
    // a redemption of A valued with, and drawing on, B's trader account
    assert_err(
        ctx.redeem("alice", &crossed, 50_000 * TOKEN, 1),
        VaultError::InvalidPhoenixAccount,
    );

    // launch A's instructions pointed at launch B's vault USDC account
    let mut crossed = a;
    crossed.vault_usdc = b.vault_usdc;
    assert_err(
        ctx.deploy(KEEPER, &crossed),
        VaultError::InvalidPhoenixAccount,
    );
    assert_err(
        ctx.redeem("alice", &crossed, 50_000 * TOKEN, 1),
        VaultError::InvalidPhoenixAccount,
    );

    // B is untouched by all of it
    assert_eq!(ctx.perp(&b).base_lots, ctx.perp(&a).base_lots);
    assert_eq!(ctx.balance(&b.vault_usdc), 0);
}

#[test]
fn the_keeper_and_the_admin_have_no_path_to_vault_funds() {
    let idl: serde_json::Value =
        serde_json::from_str(include_str!("../../target/idl/terp.json")).unwrap();
    let instructions = idl["instructions"].as_array().unwrap();

    // the full instruction set; adding one must be a deliberate, reviewed change
    let mut names: Vec<&str> = instructions
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, EXPECTED);

    for instruction in instructions {
        let name = instruction["name"].as_str().unwrap();
        let accounts: Vec<&str> = instruction["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap())
            .collect();
        // the keeper signs only the two instructions that put tax to work; neither takes a
        // destination account it could choose. `convert_tax` pays the keeper fee to
        // `treasury_usdc`, which the program requires to belong to the configured treasury
        // (see `the_keeper_fee_can_only_go_to_the_configured_treasury` in tax.rs).
        if accounts.contains(&"keeper") {
            assert!(["convert_tax", "deploy"].contains(&name), "{name}");
            for forbidden in ["owner_usdc", "caller_usdc", "keeper_usdc"] {
                assert!(!accounts.contains(&forbidden), "{name}: {accounts:?}");
            }
            assert_eq!(accounts.contains(&"treasury_usdc"), name == "convert_tax");
        }
        // the admin signs only the config instructions and market listings, and none of them
        // takes a vault, a token account or a launch
        if accounts.contains(&"admin") {
            assert!(
                ["init_config", "update_config", "add_market"].contains(&name),
                "{name}"
            );
            let allowed = [
                "admin",
                "config",
                "system_program",
                "market",
                "orderbook",
                "spline",
            ];
            assert!(
                accounts.iter().all(|a| allowed.contains(a)),
                "{name}: {accounts:?}"
            );
        }
        // the creator signs only to create the launch and to record its pool
        if accounts.contains(&"creator") {
            assert!(["create_launch", "set_pool"].contains(&name), "{name}");
        }
    }
    // redemption, deleveraging and claim payouts never depend on the keeper or the admin
    for name in [
        "redeem",
        "deleverage",
        "pay_claim",
        "fund_claims",
        "unwrap_canonical",
        "collect_tax",
    ] {
        let instruction = instructions.iter().find(|i| i["name"] == name).unwrap();
        let accounts: Vec<&str> = instruction["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["name"].as_str().unwrap())
            .collect();
        assert!(
            !accounts.contains(&"keeper")
                && !accounts.contains(&"admin")
                && !accounts.contains(&"config"),
            "{name}: {accounts:?}"
        );
    }
}

/// Every instruction of the program, sorted.
const EXPECTED: [&str; 15] = [
    "add_market",
    "collect_tax",
    "convert_tax",
    "create_launch",
    "deleverage",
    "deploy",
    "fund_claims",
    "init_config",
    "pay_claim",
    "redeem",
    "register_trader",
    "set_pool",
    "sweep_residual",
    "unwrap_canonical",
    "update_config",
];
