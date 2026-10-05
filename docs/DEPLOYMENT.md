# Deployment

Nothing in this repository has been deployed, and nothing deploys by itself. Every step below
that spends funds is marked **SPENDS** and waits for a person: scripts simulate first, print what
they will do, and send only after you type the confirmation phrase. `--dry-run` stops after the
simulation.

## 0. Build and test locally (free)

Toolchain: Rust, Solana CLI 3.x, Anchor CLI 1.0.2, Node 22+, pnpm 10. The programs were built and
tested on Linux (WSL).

```sh
pnpm install
anchor build
cargo test -p terp --lib                      # accounting and CPI encoding
cp target/idl/terp.json packages/sdk/src/idl/ # the SDK reads the IDL from here
PHOENIX_MAINNET_BPF_PROGRAMS=1 \
  cargo test --manifest-path tests-litesvm/Cargo.toml -- --test-threads=1
pnpm -r typecheck && pnpm test:sdk
```

The integration tests download the deployed Phoenix, Ember and Hawkeye binaries from mainnet on
first run (read-only) and cache them.

### Local end-to-end run against the real Meteora program (free)

`scripts/localnet` runs a whole launch on a throwaway `solana-test-validator` that carries the
deployed Meteora DLMM program, cloned from mainnet. It reads from mainnet (the DLMM program, two
Phoenix market accounts, the USDC mint account) and sends nothing there. USDC on the local
validator is a **MOCK**: mainnet's mint account with its mint authority replaced by a test key,
so the run can print itself USDC. The script refuses to run if the RPC it is pointed at is
mainnet.

```sh
anchor build                                   # the validator loads target/deploy/terp.so
pnpm --filter @terp/scripts localnet:setup     # test keypairs and the mock USDC mint, in .localnet/
scripts/localnet/start-validator.sh            # Linux/WSL; leave it running
pnpm --filter @terp/scripts localnet:e2e       # in a second terminal
```

`MAINNET_RPC_URL` chooses the RPC the clone reads from; `LOCAL_RPC_URL` the validator the script
talks to (default `http://127.0.0.1:8899`).

What it does: config and SOL market; a 3% mint and its launch; a DLMM pool seeded with tokens
only into positions owned by the launch vault and locked; a buy, the sweep of its tax, and the
keeper's `convert_tax` through the real pool; then the creator's attempts to remove the
liquidity and to claim the pool fees to their own wallet, which must fail, and a claim into the
vault, which must succeed. It exits non-zero if the liquidity turns out not to be locked.

What it does not cover: Phoenix (no trader is registered, nothing is deployed), mainnet pool
state and compute, and the frontend.

## 1. Preflight (free, read-only)

```sh
RPC_URL=<mainnet rpc> pnpm --filter @terp/scripts preflight
```

Checks the external programs, parses Phoenix's live global configuration and compares it with
Phoenix's API, reads the SOL mark through Hawkeye, and reports whether the program is deployed.

## 2. Review before deploying

- The program id is `target/deploy/terp-keypair.json`, declared in `programs/terp/src/lib.rs`
  and `Anchor.toml`. Keep that keypair; it is not in git.
- Decide the upgrade authority. A single hot key is not acceptable for real funds: use a multisig
  with a timelock, or plan to revoke it.
- Decide three keys, all yours as the operator, and keep them separate:
  - **admin**: rotates roles, lists markets, pauses. Keep it cold.
  - **keeper**: lives on the server that runs the keeper service. It can only trigger conversion
    and deployment; it cannot withdraw.
  - **treasury**: receives the keeper fee on every tax conversion, and residual USDC of launches
    whose supply reached zero. This is where platform revenue accumulates; a multisig is fine.
- Decide the **keeper fee**: the share of converted tax paid to the treasury, 0 to 2000 bps (20%
  is the program's cap). `--keeper-fee-bps` defaults to 300 (3%). Each launch keeps the rate in
  force when it is created.
- Read `docs/SECURITY.md`, "Known limitations".

## 3. Deploy the program — **SPENDS** about 4.5 SOL of rent, plus fees

```sh
solana program deploy target/deploy/terp.so \
  --program-id target/deploy/terp-keypair.json \
  --upgrade-authority <authority keypair> \
  --url <mainnet rpc>
```

Do not deploy `mock_swap.so`. It is a test fixture.

## 4. Initialise the config — **SPENDS** rent for one account

Run it immediately after step 3: the first caller becomes admin.

```sh
RPC_URL=<mainnet rpc> ADMIN_KEYPAIR=<path> \
  pnpm --filter @terp/scripts init-config --keeper <pubkey> --treasury <pubkey> \
  --keeper-fee-bps <bps> --dry-run
# then again without --dry-run, and type the phrase
```

It pins the AMM to Meteora DLMM (`swap`, `swap2`), which cannot be changed afterwards, sets the
keeper fee, and creates the treasury's USDC account if it does not exist (conversions fail
without it). Rerun `preflight` and confirm the admin, keeper, treasury and fee are yours.

Then list the leveraged assets launches may choose. Each listing **SPENDS** rent for one small
account and is permanent:

```sh
RPC_URL=<mainnet rpc> ADMIN_KEYPAIR=<path> \
  pnpm --filter @terp/scripts add-market --symbol SOL --dry-run
```

The script reads the market from Phoenix's API, checks it against the chain, and prints what it
will list. Start with SOL. `preflight` re-checks every listing.

## 5. Create the shared lookup table — **SPENDS** a little rent

```sh
RPC_URL=<mainnet rpc> PAYER_KEYPAIR=<path> \
  pnpm --filter @terp/scripts create-lookup-table --dry-run
```

Redemptions and deployments need it to fit in one transaction. Put the printed address in
`LOOKUP_TABLE` (keeper) and `NEXT_PUBLIC_LOOKUP_TABLE` (frontend).

## 6. Create a launch (frontend) — **SPENDS** rent and locks the pool's tokens for good

```sh
cp app/.env.example app/.env.local   # NEXT_PUBLIC_RPC_URL must be an RPC that allows browsers
pnpm dev
```

The RPC must also allow `getProgramAccounts` on the DLMM program: the liquidity-lock status is
read with it.

The creator picks the tax tier (1% or 3%) and the leveraged asset; both are permanent. They also
pick a starting market cap (which sets the starting price) and how far up the seeded price range
goes (10x to 100x, 50x by default). No USDC is deposited at any point.

Before starting, the creator's wallet needs:

- SOL for rent and fees (each review shows the simulated amount; step 3 shows the SDK's rent
  estimate for the positions and price-bin accounts, which is not returned);
- **a little USDC, any amount.** Meteora only lets a wallet create the pool if it holds a
  non-zero balance of both tokens. It is checked, not taken;
- a creator allocation of at least the transfer tax on the pool allocation (about 3.09% of it
  for a 3% tax, 1.01% for 1%), because seeding the pool is a taxed transfer. The form enforces
  this.

`/create` walks through four steps, each reviewed and simulated before the wallet prompt:

1. **Create the mint and the launch.** One transaction. Records the starting reference price.
2. **Create the DLMM pool and record it.** One transaction. The pool is created with trading
   opening 1,500 slots later, **about 10 minutes**. The page shows the slot and a countdown.
3. **Seed the pool with tokens only.** Several transactions (7 for a 50x range: one proof, three
   that create positions, three deposits), reviewed together and signed in one wallet approval
   if the wallet supports it, then sent one after another. The positions are owned by the vault
   and never unlock: **the tokens cannot be taken back**. This step **must be confirmed before
   trading opens**; do step 2 only when ready to do step 3 straight away. If the page reloads,
   reopen `/create?mint=<mint>` in the same browser tab and the step continues from what is on
   chain. If trading opens first, the launch cannot be seeded as locked any more, the page
   says so and stops, and the only way forward is a new launch.
4. **Register the Phoenix trader account.** One transaction; any wallet can send it.

Read the pool parameters, the starting reference price and the seeding review before signing.
The pool parameters (bin step 2%, base fee 1%, curvature 0.6) are constants in
`app/src/lib/liquidity.ts` and **have not been confirmed by the product owner**.

Afterwards the token page shows, from chain, whether the pool's liquidity is locked in the
vault, and the unclaimed pool fees. The creator's wallet can claim those fees into the vault
there ("Claim pool fees into the vault"); it is the only wallet that can, and they can go
nowhere else.

These wallet flows have not been run in a browser against a validator. Try the whole of step 6
with a throwaway token and small amounts first.

## 7. Phoenix onboarding — **SPENDS** fees; depends on Phoenix

```sh
RPC_URL=<mainnet rpc> PAYER_KEYPAIR=<path> \
  pnpm --filter @terp/scripts onboard-trader --mint <launch mint> --dry-run
```

Until Phoenix enables the launch's trader account, the exchange rejects its deposits and orders,
so `deploy` cannot work. Tax collection, conversion and redemptions against idle USDC work
without it.

## 8. Run the keeper

The keeper is your service, signing with the keeper key from step 4.

```sh
cp .env.example .env    # RPC_URL, KEEPER_KEYPAIR, LOOKUP_TABLE
pnpm keeper             # KEEPER_MODE defaults to dry-run
```

In dry-run it builds and simulates every action and prints what it would do, including the
compute units each simulation used. Watch it first. The compute budget of the combined
sweep-sell-deploy transaction on mainnet state has not been measured (see FEASIBILITY.md); if it
does not fit, the keeper falls back to sending the steps separately.

Going live **SPENDS** fees and **opens and increases mainnet positions** for every launch:

```sh
KEEPER_MODE=live pnpm keeper
```

Position sizes are set by the program from each vault's own USDC, not by the keeper. To limit
exposure while testing, use `set-paused` to stop conversion and deployment. Remember that a
vault starts with tax tokens from the seeding of its pool, so the keeper has something to sell
as soon as the pool has buyers.

## Pausing

`update_config` with `paused = true` stops new launches, tax conversion and deployment. It never
stops deleveraging, redemptions or claim payouts.

```sh
RPC_URL=<mainnet rpc> ADMIN_KEYPAIR=<path> pnpm --filter @terp/scripts set-paused --paused true
```

## Replacing the keeper key

If the keeper key is lost or exposed, the admin sets a new one with `update_config`
(`client.updateConfigIx(admin, { keeper })` in the SDK). An exposed keeper key cannot move funds;
replace it anyway.
