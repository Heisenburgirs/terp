# Terp (MVP)

Terp is a Solana launchpad where a token's transfer tax funds a leveraged perp position that
its holders can redeem against.

The tax works like a StonkFun reward launch: a fixed-supply Token-2022 token with a permanent
1% or 3% transfer tax, taken on every transfer on any venue, swept and sold in the token's own
pool. Two things differ. The tax does not go to an operator wallet: each token has its own
on-chain vault (a PDA) that is the only account able to withdraw it, and the platform's cut is a
fixed platform fee the program pays out of each sale. And the proceeds are not paid out: the vault
deposits them on Phoenix as collateral for a leveraged long on the asset the creator chose.

Each launch is:

- a fixed-supply **Token-2022** token with an immutable 1% or 3% transfer tax, chosen at launch,
- a token/USDC pool on **Meteora DLMM** that the creator seeds with **tokens only**, spread over
  price bins from a starting price up to a multiple of it. Buyers' USDC fills the pool as the
  price rises. It is the final pool from the first trade: no bonding curve, no migration. The
  liquidity positions belong to the token's vault and are locked for good,
- **one vault per token**. Tax from that token's transfers goes to that token's vault and nowhere
  else. The vault sells it for USDC and deposits the USDC on **Phoenix perpetuals** behind a
  long on the launch's leveraged asset (SOL, BTC, or any market the protocol has listed),
- a position meant to **stay open and close to 5x**, in profit or not: every deposit of tax is
  added margin. If leverage is then under 4.75x, exposure is bought back up to 5x, never above.
  Between 4.75x and 5x nothing is traded. Between 5x and 6x (after the asset has fallen) tax is
  margin only, pulling leverage back toward 5x. Above 6x the position is cut to 5.5x. A
  vault with collateral never stays flat: after a closure or a liquidation the next tax opens a
  new position,
- a one-transaction redemption: holders burn tokens, the vault unwinds their share of the
  position, and they receive their proportional share of net vault equity in USDC, less a 3%
  redemption fee that stays with the remaining holders.

**Nobody operates the market.** There is no keeper role and no privileged key in the upkeep
path. Sweeping withheld tax (`collect_tax`), selling a batch of it (`convert_tax`) and adjusting
the position (`rebalance`) are instructions any wallet can send. The caller supplies the moment
and nothing else: the program fixes how much, at what price, and where the money goes, and the
caller receives nothing.

What makes it run is trading. When someone buys or sells through Terp's trade panel, the same
transaction also carries those steps when there is work and it fits, so trading itself turns tax
into the position and keeps the position in its band. A small open bot, the crank, does the same
for tokens nobody is trading on Terp's site; anyone can run it with any funded wallet. If neither
happens, tax waits and the position is not adjusted. Redemptions never depend on any of it.

**Platform revenue** is the platform fee: the platform's share, 3%, of the USDC every tax sale brings in (set in the
config, capped by the program at 20%, and frozen into each launch when it is created), which the
program pays to the platform treasury inside the sale. The other 97% goes to the token's vault,
with a 1% tax or a 3% tax alike. The fee is the only thing the platform takes.

**Pool liquidity** is not the creator's to take back. The create flow puts the pool allocation
into DLMM positions owned by the vault with a lock that never releases; the creator's wallet is
only their operator and cannot withdraw. The pool's swap fees accrue to those positions in USDC
and can only be claimed into the vault. This is done by the create flow and shown from chain on
each token's page; the Terp program does not enforce it (see SECURITY.md).

**Status.** Built and tested locally against the deployed Phoenix binaries, and the launch, the
locked seeding and a tax sale were run on a local validator against the deployed Meteora DLMM
binary. **Not deployed to mainnet, not audited.** The frontend's wallet flows have not been run
in a browser against any deployment. Nothing here spends funds without a person confirming it.

Neither principal nor yield is guaranteed. A liquidation can destroy the backing. A profitable
position does not make token buyers profitable.

## Read first

| Document | Contents |
|---|---|
| [docs/FEASIBILITY.md](docs/FEASIBILITY.md) | What was verified about Meteora and Phoenix, how, and what was not; why not a transfer hook |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Accounts, authorities, instructions, how upkeep happens, what a caller can and cannot do |
| [docs/ECONOMICS.md](docs/ECONOMICS.md) | `S`, `q`, `E`, the platform fee, the position strategy, the redemption formula |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and known limitations |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Step-by-step, with every spending step marked |

## Layout

```
programs/terp         on-chain program (Anchor 1.0)
programs/mock-swap    MOCK AMM for local tests only; never deployed
tests-litesvm         integration tests against real Phoenix, Ember, Hawkeye, Token-2022
packages/sdk          TypeScript SDK: instructions, vault state, history, math mirror
keeper                the crank: an open upkeep bot with no on-chain role (the folder name is historical); dry-run by default
scripts               preflight (read-only), init-config, add-market, create-lookup-table, onboard-trader, set-paused
scripts/localnet      a whole launch on a local validator against the real DLMM program; MOCK USDC, never mainnet
app                   Next.js frontend
```

## Build and test

Rust, Solana CLI 3.x, Anchor CLI 1.0.2, Node 22+, pnpm 10. Programs were built on Linux (WSL).

```sh
pnpm install
anchor build
cargo test -p terp --lib
PHOENIX_MAINNET_BPF_PROGRAMS=1 cargo test --manifest-path tests-litesvm/Cargo.toml -- --test-threads=1
pnpm -r typecheck && pnpm test:sdk
RPC_URL=<mainnet rpc> pnpm --filter @terp/scripts preflight   # read-only
```

If `CARGO_TARGET_DIR` is set, copy `terp.so` and `mock_swap.so` from its `deploy/` directory
into `target/deploy/` before running the integration tests, or point `TERP_DEPLOY_DIR` at it.

A launch against the real Meteora DLMM program, on a local validator (see DEPLOYMENT.md):

```sh
pnpm --filter @terp/scripts localnet:setup    # test keys and a MOCK USDC mint
scripts/localnet/start-validator.sh           # Linux/WSL; clones the DLMM program, read-only
pnpm --filter @terp/scripts localnet:e2e      # in a second terminal
```

## What the tests cover

- **Accounting** (unit and property tests): payout bounds; backing per remaining token never
  falls; proportional redemption alone does not raise it; the retained fee does; a full exit
  drains the vault exactly; splitting a redemption cannot beat the pro-rata share.
- **Launch validation**: mints with a live mint authority, a tax outside the 1% / 3% tiers or
  capped, a fee authority, a foreign withheld authority or a permanent delegate are rejected.
- **Tiers and markets**: a 1% launch taxes 1% into its own vault; a launch levers the asset it
  chose and cannot be pointed at another; only the admin lists markets and a listing is permanent.
- **Tax**: proceeds are split between the vault and the platform fee exactly; the fee can only
  go to the configured treasury, is capped, and a launch keeps the rate it was created with; any
  wallet converts and gains nothing by it, and no caller can choose the batch size, sell below
  the price floor (including on the very first sale), call an instruction outside the allowlist,
  or keep the output.
- **Rebalance**: any wallet deposits idle USDC, tops the position up after a rally and cuts it
  above 6x; with nothing to do it succeeds and changes nothing; a token transfer with a
  `rebalance` in the same transaction lands even when the mark is stale, the protocol is paused
  or the account is about to be liquidated; a cut still works while paused; nothing happens
  until Phoenix has enabled the trader account.
- **Position strategy**: any wallet deploys and the program sizes it; the first deposit
  opens at 5x; after a fall tax is margin only until leverage is under 4.75x, then exposure
  returns to 5x even below entry; a small drift under target is left alone; a rally is topped up
  to 5x, with or without new tax, never above; margin added in time keeps it under 6x; a closed
  position is reopened by the next tax; a partial fill is completed by the next call; stale marks
  are refused; above 6x anyone may deleverage, which cuts the position to 5.5x.
- **Redemption**: one transaction, no transfer fee, the redeemer pays the real exit cost and the
  others keep the fee; minimum payout; idle USDC used first; double redemption; stale mark; a
  wiped-out position; a queued Phoenix withdrawal becoming a fixed, reserved claim; re-requesting
  a dropped withdrawal; an unlevered vault; the final redemption and residual sweep.
- **Isolation and authority**: one launch's loss and accounts never reach another; no caller
  and no admin has a path to vault funds; the admin signs only config and listings; everything
  else needs no role.

- **Pool and lock** (`scripts/localnet/e2e.ts`, against the deployed DLMM binary on a local
  validator, not part of the test suites above): tokens-only seeding into positions owned by the
  vault; the creator cannot remove the liquidity; pool fees can only be claimed into the vault;
  a buy, its tax, and its sale through the real pool by a wallet with no role, with the
  platform fee split. The script now also sends a `rebalance` from the buyer's wallet, which
  must succeed doing nothing there; that step was added after the last run and has not been
  run yet.

Mocks are confined to the test harness and labelled there: the AMM, Phoenix's onboarding step,
Phoenix paying or dropping a queued withdrawal, and shortcut "revenue" minted straight into a vault.
The local validator run uses the real DLMM program and a mock USDC mint.
