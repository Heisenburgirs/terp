//! A launch only accepts a mint whose economics nobody can change afterwards.
use terp_litesvm::*;

const SUPPLY: u64 = 1_000_000 * TOKEN;

fn rejects(opts: MintOpts, error: VaultError) {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(opts);
    assert_err(ctx.create_launch(mint, default_args(opts.supply)), error);
}

#[test]
fn accepts_a_valid_mint_and_records_the_disclosed_allocation() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    let created = event::<LaunchCreated>(&ok(ctx.create_launch(mint, default_args(SUPPLY))));
    assert_eq!(created.initial_supply, SUPPLY);
    assert_eq!(created.creator_allocation + created.pool_allocation, SUPPLY);

    let keys = ctx.keys(mint);
    let launch = ctx.launch(&keys);
    assert_eq!(launch.creator, ctx.creator);
    assert_eq!(launch.target_leverage_bps, 50_000);
    assert_eq!(launch.redemption_fee_bps, 300);
    assert!(!launch.is_trader_registered());
    // the vault's accounts exist and are empty
    assert_eq!(ctx.balance(&keys.vault_usdc), 0);
    assert_eq!(ctx.balance(&keys.tax_account), 0);
}

#[test]
fn rejects_a_mint_that_can_still_be_minted() {
    rejects(
        MintOpts {
            revoke_mint_authority: false,
            ..MintOpts::valid(SUPPLY)
        },
        VaultError::MintAuthorityPresent,
    );
}

#[test]
fn rejects_a_transfer_fee_outside_the_published_tiers() {
    rejects(
        MintOpts {
            fee_bps: 500,
            ..MintOpts::valid(SUPPLY)
        },
        VaultError::InvalidTransferFee,
    );
}

#[test]
fn rejects_a_capped_transfer_fee() {
    rejects(
        MintOpts {
            max_fee: 1_000,
            ..MintOpts::valid(SUPPLY)
        },
        VaultError::InvalidTransferFee,
    );
}

#[test]
fn rejects_a_fee_the_creator_could_still_change() {
    rejects(
        MintOpts {
            fee_config_authority: true,
            ..MintOpts::valid(SUPPLY)
        },
        VaultError::TransferFeeAuthorityPresent,
    );
}

#[test]
fn rejects_withheld_fees_the_creator_could_withdraw() {
    rejects(
        MintOpts {
            foreign_withheld_authority: true,
            ..MintOpts::valid(SUPPLY)
        },
        VaultError::InvalidWithheldAuthority,
    );
}

#[test]
fn rejects_a_permanent_delegate_that_could_seize_tokens() {
    rejects(
        MintOpts {
            permanent_delegate: true,
            ..MintOpts::valid(SUPPLY)
        },
        VaultError::UnsupportedMintExtension,
    );
}

#[test]
fn rejects_a_supply_or_allocation_that_does_not_add_up() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));

    let mut args = default_args(SUPPLY);
    args.total_supply = SUPPLY - 1;
    args.pool_allocation -= 1;
    assert_err(ctx.create_launch(mint, args), VaultError::SupplyMismatch);

    let mut args = default_args(SUPPLY);
    args.creator_allocation -= 1;
    assert_err(
        ctx.create_launch(mint, args),
        VaultError::AllocationMismatch,
    );
}

#[test]
fn the_pool_is_set_once_and_only_by_the_creator() {
    let mut ctx = Ctx::new();
    let keys = ctx.launch_with_pool(SUPPLY, 30_000 * USDC);
    assert_eq!(ctx.launch(&keys).pool, keys.pool);

    // not again, and not by someone else
    assert_err(
        ctx.set_pool_as(CREATOR, &keys, keys.pool),
        VaultError::PoolAlreadySet,
    );
    ctx.user("mallory", &keys.mint);
    assert_err(
        ctx.set_pool_as("mallory", &keys, keys.pool),
        VaultError::Unauthorized,
    );
}

#[test]
fn a_pool_must_belong_to_the_configured_amm() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
    let keys = ctx.keys(mint);
    // the vault's own USDC account is owned by the token program, not the AMM
    assert_err(
        ctx.set_pool_as(CREATOR, &keys, keys.vault_usdc),
        VaultError::InvalidPool,
    );
}

#[test]
fn pausing_blocks_new_launches() {
    let mut ctx = Ctx::new();
    let mint = ctx.create_mint(MintOpts::valid(SUPPLY));
    ctx.set_paused(true);
    assert_err(
        ctx.create_launch(mint, default_args(SUPPLY)),
        VaultError::Paused,
    );
    ctx.set_paused(false);
    ok(ctx.create_launch(mint, default_args(SUPPLY)));
}
