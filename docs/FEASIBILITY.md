# Feasibility assessment

Checked on 2026-10-04 against the official documentation, the public SDK source, and the live
mainnet accounts. "Verified" below means one of: read from the live chain, read from the vendor's
published source, or exercised in this repository's tests against the deployed program binaries.

## Verdict

The product is buildable on mainnet as specified, with four things to know up front:

1. **Redemption is one transaction, but the payout cannot always be.** Phoenix throttles USDC
   withdrawals exchange-wide and queues what does not fit. A redemption burns, closes the
   holder's share of the position and pays in one instruction; if Phoenix queues the withdrawal,
   the unpaid part becomes a fixed claim that is paid when the USDC arrives.
2. **A token transfer cannot send its tax to the vault by itself.** Token-2022 withholds the tax
   inside the recipient's token account, and a transfer hook cannot move it (see below). The tax
   is swept by a `collect_tax` instruction. The operator's keeper sends sweep, sale and deployment
   as one transaction, so in practice it is one step that follows the trades.
3. **Each launch depends on Phoenix's onboarding API once.** A program can create a Phoenix trader
   account for a PDA by CPI, but the account has no capabilities until Phoenix's onboarder enables
   them. Phoenix exposes this as a public builder API that explicitly accepts PDA authorities.
   It is an off-chain dependency on Phoenix, not a blocker.
4. **Phoenix's read-only views are expensive on mainnet** (200k to 380k compute units each on live
   state, against about 9k in the local fixture). The program is designed around one valuation
   view per read. The full instruction budget on mainnet has not been measured, because that
   requires deploying. See "Not verified".

## Meteora: which pool

**DLMM** supports the required configuration permissionlessly, so DLMM is used.

- A Token-2022 mint that uses only `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata` (or a
  `TransferHook` with program and authority revoked) can be used in DLMM without a token badge.
  Source: [DLMM Token 2022 support](https://docs.meteora.ag/core-products/dlmm/token-2022-support).
- DAMM v2 supports the same set permissionlessly and is the documented alternative:
  [DAMM v2 Token 2022 support](https://docs.meteora.ag/core-products/damm-v2/token-2022-support).
- Launch mints here carry exactly `TransferFeeConfig` + `MetadataPointer` + `TokenMetadata`, and
  `create_launch` rejects any other extension.
- DLMM program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`: verified executable on mainnet.
- SDK `@meteora-ag/dlmm` 1.9.14. Methods used, all read from its typings:
  `createCustomizablePermissionlessLbPair2` (the Token-2022 capable pool creation), `create`,
  `getBinArrayForSwap`, `swapQuote`, `swap`, `seedLiquidity`, `getPositionsByUserAndLbPair`,
  `claimAllSwapFee`, and `wrapPosition` to decode a position's operator and lock release point,
  which the SDK's `positionData` does not carry.
- Verified read-only against a live mainnet pool: `swap` emits exactly one DLMM instruction, it is
  `swap2`, and its only signer is the `user`, which here is the launch's tax PDA.

### Verified against the real DLMM program on a local validator

How: `solana-test-validator` with the mainnet DLMM binary cloned into it
(`--clone-upgradeable-program`), the locally built terp program, and a mock USDC mint;
`scripts/localnet/e2e.ts` sends real transactions to it. See DEPLOYMENT.md. This is the deployed
program, but not mainnet state.

- **Tokens-only seeding into positions owned by a PDA.** `seedLiquidity` with owner = the Launch
  PDA, fee owner = the Launch PDA, operator = the creator, lock release point = u64 max. The SDK
  throws for an off-curve owner (`TokenOwnerOffCurveError`), so the instructions are built for a
  placeholder owner and its token account, and both are rewritten to the Launch PDA's. With a
  2% bin step and a 50x range: 1 + 3 + 3 transactions, about 420k compute units for each
  position-creating transaction and 145k for each deposit.
- **Positions for another owner need a pool that is not yet active.** After activation DLMM
  rejects `initialize_position_by_operator` (`UnauthorizedAccess`). So the pool is created with
  a future activation slot, seeded, and opens afterwards.
- **The pool creator must hold both tokens.** Without a non-zero USDC balance, pool creation
  fails (`MissingTokenAmountAsTokenLaunchProof`). Nothing is deposited.
- **The transfer tax applies to the seed deposit.** The SDK grosses the deposit up: the pool
  receives the whole amount and about 3.09% more (for a 3% tax) leaves the depositor, withheld
  as tax in the pool's token account.
- **`LiquidityLocked` on removal.** The operator's `removeLiquidity`, with and without closing
  the position, is rejected.
- **Fee destination is enforced.** With `CollectFeeMode.OnlyY` fees accrue in USDC. A claim by
  the operator that names the creator's own accounts is rejected
  (`WithdrawToWrongTokenAccount`); a claim by a wallet that is not the operator is rejected even
  when it names the vault; the operator's claim into the vault's USDC account succeeds.
- **`convert_tax` through a real DLMM swap.** A buy leaves withheld tax, `collect_tax` sweeps it,
  and `convert_tax` wraps the SDK's single `swap2` instruction signed by the tax PDA. The
  proceeds are split 97% to the vault and 3% to the treasury, the configured keeper fee.
- **The variable fee is large in a thin pool.** A single 2,000 USDC buy that crossed about 65
  bins paid about 8% in pool fees, against a 1% base fee.

DLMM is closed-source: these are observations of the binary deployed on the day of the test, and
an upgrade by Meteora could change them.

## Phoenix perpetuals

This is Phoenix **perps** ("Eternal"), a different program from the Phoenix v1 spot order book
(`PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY`). Nothing here touches the spot program.

| Item | Value | How verified |
|---|---|---|
| Perps program | `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih` | SDK source; executable on mainnet |
| Ember (USDC wrapper) | `EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy` | executable on mainnet |
| Hawkeye (views) | `RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj` | SDK source; executable on mainnet |
| Global config | `2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ` | PDA `["global"]`; layout parsed from the live account and matched against Phoenix's API |
| SOL perp | asset 0, orderbook `71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2` | Phoenix API; `scripts/preflight.ts` |
| SOL parameters | max leverage 25x, taker fee 3.5 bps, base lot 0.01 SOL | Phoenix API |

- **SDK and CPI.** The public Rise SDK ([docs](https://docs.phoenix.trade/sdk/on-chain-programs),
  [source](https://github.com/Ellipsis-Labs/rise-public)) documents a CPI surface: `RegisterTrader`,
  `PhoenixDeposit`, `PhoenixWithdraw`, `PlaceMarketOrder`, `EmberDeposit`, `EmberWithdraw`, and
  Hawkeye views. Its CPI types are Pinocchio-based, so this program encodes the same instructions
  by hand from the SDK's layouts and tests them against the deployed binaries.
- **Account ownership and PDA signing.** A trader account is the PDA
  `["trader", authority, [pda_index, subaccount_index]]`. The authority can be a program PDA,
  which signs deposits, withdrawals and orders by CPI. Each launch PDA is its own authority, so
  each launch has its own cross-margin trader account. That is what isolates launches.
- **Collateral.** USDC is wrapped 1:1 by Ember into Phoenix's canonical token, which is what the
  exchange holds. Quote lots are USDC atoms (6 decimals).
- **Closing positions.** Reduce-only immediate-or-cancel orders, with a fill summary in return data.
  Partial fills are possible and are handled by checking state after the fill.
- **Valuation.** Hawkeye's `view_margin_for_asset` returns position, mark, unrealized PnL, unsettled
  funding and maintenance margin as CPI return data. Collateral is read from the trader account.
- **Onboarding.** [Trader onboarding](https://docs.phoenix.trade/sdk/register): "You may pass an
  on-curve wallet address or an off-curve PDA as the trader authority." Phoenix's onboarder
  co-signs. `scripts/onboard-trader.ts` implements it.

## Why not a transfer hook

"The transfer that crosses the threshold opens the position" would need a Token-2022 transfer
hook. It does not work here:

- **Reentrancy.** The hook runs while Token-2022 is executing the transfer, and Solana forbids
  calling back into a program already on the call stack. The hook therefore cannot move the
  hooked token at all: it cannot collect withheld fees or sell tax tokens. When the transfer is
  part of a Meteora swap, Meteora is on the stack too and cannot be called either.
- **Listing.** DLMM and DAMM v2 accept a hooked mint permissionlessly only when the hook program
  and authority are both removed. An active hook needs a token badge from Meteora per token.
- **Failure coupling.** A failed inner call aborts the whole transaction. Any Phoenix rejection
  (stale mark, paused market, withdrawal queue) would make the token untransferable.
- **Limits.** Meteora -> Token-2022 -> hook -> Phoenix -> Phoenix's own inner call is at the
  call-depth limit before an aggregator is added, and each Phoenix view costs several hundred
  thousand compute units on mainnet.

What is built instead: the token program withholds the tax on every transfer, as it is designed
to; `collect_tax` sweeps it into the token's own vault; and the keeper bundles that sweep with
`convert_tax` and `deploy` in a single transaction once a launch's thresholds are crossed. All
three are separate instructions of one program, so they compose without any reentrancy.

## Atomic redemption or a queue

Atomic burn and valuation, with a deferred payout when Phoenix queues. From Phoenix's [collateral documentation](https://docs.phoenix.trade/phoenix/collateral-and-accounts/collateral):
a withdrawal "clears immediately if the queue is empty and the request fits within the current
withdrawal budget. Otherwise, the withdrawal is queued", processed FIFO, never partially, and it
"can be dropped" if the account no longer has enough withdrawable collateral. Stated mainnet
parameters: budget 2,000,000 USDC, refill 450 USDC per slot. There is also a post-deposit
withdrawal cooldown, read from the live global config as 6 slots.

The tests reproduce both behaviours with the real program: a withdrawal inside the budget is paid
at once, and one outside it is queued while the position reduction still takes effect.

So the payout of a redemption that needs collateral out of Phoenix cannot be guaranteed in the
same transaction. `redeem` does everything that can be atomic (value, close the holder's share
of the position, request the withdrawal, burn) and pays what is available. If Phoenix queued the
withdrawal, the remainder is recorded as a fixed USDC claim, senior to vault equity, and
`pay_claim` pays it when the USDC arrives.

## Not verified

These need a deployment or a mainnet fork, which were not done because they spend funds or need
your approval:

- The program has not been deployed to mainnet. No mainnet pool, launch or position exists.
- Total compute units of `deploy`, `deleverage` and `redeem` on mainnet state. Measured view
  costs: `view_margin_for_asset` about 201k, `view_bbo` about 350k. Each of these instructions
  uses two position views, one mark view, one order and at most one withdrawal, so the estimate
  is 750k plus the order and withdrawal, inside the 1.4M limit. The cost of a Phoenix order on
  mainnet is the unmeasured term. Check with dry-run simulations before the first live action.
- That a `redeem` transaction fits in one packet on mainnet. It carries about 36 accounts and
  needs the shared address lookup table (`scripts/create-lookup-table.ts`).
- `convert_tax` through DLMM **on mainnet**. It was executed against the real DLMM binary on a
  local validator (above); the Rust test suites still use a mock AMM. Mainnet pool state, and the
  compute and size of the keeper's combined transaction with a real DLMM swap in it, are not
  measured.
- The frontend's create flow in a browser: the multi-transaction seeding through a wallet
  (`signAllTransactions`), resuming it after a reload, the countdown to activation, and the fee
  claim. It builds the same DLMM instructions as the local script but has only been compiled.
- An activation window of 1,500 slots. The local run used 150. Whether DLMM bounds how far ahead
  the activation slot may be set was not checked; the frontend's simulation of step 2 would
  show it.
- Whether the operator can still deposit into an existing locked position after activation.
- Reading the vault's positions with `getProgramAccounts` on a public mainnet RPC (some
  providers restrict it for large programs).
- Phoenix's onboarding API accepting a launch PDA in practice (documented, not exercised).
- Whether Phoenix's withdraw queue pays a queued withdrawal into the vault's canonical token
  account without further action (the SDK and tests indicate it does; the payout itself cannot be
  simulated locally).
