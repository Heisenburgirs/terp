# Architecture

**One vault per token.** A launch's vault is a PDA derived from the token's mint. It is the mint's
only withdraw-withheld authority, so tax from that token's transfers can only ever go to that
token's vault. The same PDA owns the vault's USDC and is the authority of its own Phoenix
trader account, so each token's collateral and position are separate from every other token's.

This is the tax model of a StonkFun reward launch (permanent 1% or 3% Token-2022 transfer tax,
swept and sold in the token's own pool) with the operator wallet replaced by a program-owned
vault, and the payout to holders replaced by a leveraged position they can redeem against.

**No keeper.** No key has a role in upkeep. Sweeping tax, selling it and adjusting the position
are open to any wallet; the caller chooses the moment and nothing else. Trades made on Terp's
site carry those steps, and an open bot covers tokens nobody trades there (see "How upkeep
happens").

```
     traders                          any wallet                      holders
        |                                  |                             |
        | transfers: tax withheld          | collect + convert +         | redeem
        | in recipient accounts            | rebalance, often inside     | (one transaction)
        |                                  | a trade's own transaction   |
        v                                  v                             v
  +-----------------------------------------------------------------------------------+
  |  terp program                                                                     |
  |                                                                                   |
  |  Launch PDA  ["launch", mint]      one per token; owns the vault, signs for it    |
  |    vault USDC account              idle USDC: redemptions and claims are paid here|
  |    canonical token account         Phoenix-wrapped USDC in transit                |
  |    Phoenix trader account          collateral + position, authority = Launch      |
  |  Tax PDA     ["tax", launch]       holds swept tax tokens; signs the tax sale only|
  |  Claim PDA   ["claim", launch, owner]    USDC owed after a queued withdrawal      |
  |  Market PDA  ["market", asset]     a listed leveraged asset (SOL, BTC, ...)       |
  |  Config PDA  ["config"]            admin, treasury, platform fee, AMM, pause      |
  +-----------------------------------------------------------------------------------+
        |  CPI                      |  CPI                         |  CPI
        v                           v                              v
  Token-2022                 Meteora DLMM (swap)        Phoenix perps + Ember + Hawkeye
  withdraw withheld, burn    tax tokens -> USDC         deposit, order, withdraw, value
```

## Why the tax is swept instead of sent

Token-2022's transfer-fee extension withholds the tax inside the recipient's token account. It
has no option to deliver it elsewhere, and a transfer hook cannot take or sell the tokens being
transferred either (see "Why not a transfer hook" in FEASIBILITY.md). `collect_tax` is the
sweep. It is open to anyone and its destination is fixed.

The swept tokens sit in an account owned by a second PDA, the Tax PDA, which signs the sale and
nothing else. That keeps the swap instruction away from the PDA that owns the USDC and the
position. From the outside it is still one vault per token.

## How upkeep happens

Three instructions turn tax into the position and keep the position in its band: `collect_tax`,
`convert_tax` and `rebalance`. None of them needs a role. There are two senders in practice.

**Trades on Terp.** When a user buys or sells in the frontend's trade panel, the app appends to
the user's swap, in the same transaction, whichever of these there is work for:

1. the user's own DLMM swap, unchanged and first;
2. `convert_tax` for the batch of tax already in the vault's tax account, if a batch is ready and
   the pool's quote is above the program's price floor;
3. `collect_tax` for the token accounts the swap itself pays tax into, plus a few found by a
   periodic scan, so the next trade has a batch to sell;
4. `rebalance`, if the vault has USDC to deposit (including what step 2 brings in) or a position
   to top up or cut.

Before the user is asked to sign, the app simulates the combined transaction. If it fails,
does not fit in one packet, or uses more than 1.35M compute units, steps are left out (the tax
sale first, then the sweep, then the rebalance) until what remains passes, down to the plain
swap. The review dialog lists what rides along. The user pays the network fee and receives none
of the proceeds. The sale comes before the sweep because the program fixes the batch from the
tax balance at that moment; a sweep landing first would change it.

`rebalance` is built for this: when there is nothing safe to do it succeeds without doing
anything, so it cannot fail a trade for lack of work. `convert_tax` and `collect_tax` are strict
and fail when they have nothing to do. Simulation catches that at signing time, but a
transaction can still fail if the vault changes before it lands, for example when someone
else's transaction sells the same batch first. The user then sees a failed transaction and
retries; nothing is lost but the network fee.

**The crank.** `keeper/` (the folder name is historical) is a small bot that sends the same three
steps, in one transaction when possible, for every launch on a timer, together with claim
payouts and unwraps. It has no key the program knows about: any funded wallet can run it, and
more than one can run at once. It exists for tokens nobody is trading through Terp's site.

If neither happens, withheld tax stays where it is, collected tax stays unsold, and the position
is neither topped up nor cut. Redemption does not depend on any of it.

Trades made on other frontends or aggregators pay the transfer tax like any other transfer, but
carry no upkeep.

## Repository

| Path | What |
|---|---|
| `programs/terp` | The on-chain program (Anchor 1.0). `math.rs` is the accounting, `phoenix.rs` the Phoenix CPI layer, `instructions/venue.rs` the shared Phoenix operations. |
| `programs/mock-swap` | **MOCK** constant-product AMM, used only by local tests in place of DLMM. Never deployed. |
| `tests-litesvm` | Integration tests against the real Phoenix, Ember, Hawkeye and Token-2022 programs. |
| `packages/sdk` | TypeScript: PDAs, instruction builders, vault state, history, a bigint mirror of `math.rs`. |
| `keeper` | The crank: an open bot that sends upkeep transactions. It has no on-chain role; any funded wallet can run it. The folder name is historical. Dry-run by default. |
| `scripts` | Operator scripts: read-only preflight, config init, market listing, lookup table, Phoenix onboarding, pause. `scripts/localnet` runs a whole launch on a local validator against the real DLMM program. |
| `app` | Next.js frontend. |

## Authorities

| Authority | Holder | Enforced by |
|---|---|---|
| Mint authority | nobody | `create_launch` rejects a mint whose mint authority is set |
| Freeze authority | nobody | `create_launch` |
| Transfer-fee config authority | nobody; the tax is 1% or 3% as chosen, uncapped, with no pending change | `create_launch` |
| Withdraw-withheld authority | the Launch PDA | `create_launch`; only `collect_tax` uses it, and its destination is fixed |
| Metadata update / pointer authority | nobody | `create_launch` |
| Other mint extensions | none allowed (no permanent delegate, hook, etc.) | `create_launch` |
| Vault USDC, canonical account, Phoenix trader | the Launch PDA | only program instructions sign for it |
| Tax tokens | the Tax PDA | signs the tax sale only; holds nothing else |
| Launch policy (tax tier, leveraged asset, leverage limits, platform fee, fees, thresholds) | nobody; fixed at creation | no instruction changes a `Launch`'s policy |
| List of leveraged assets | the admin can add a market; a listing can never be edited or removed | `add_market`; a launch copies its market at creation |
| Pool address | set once by the creator | `set_pool` |
| LP positions seeded at launch | the Launch PDA, with a lock that never releases; the creator's wallet is their operator and can deposit and trigger fee claims, not withdraw | Meteora DLMM, when the launch is made through the frontend's create flow. **Not enforced by this program**; the frontend reads it from the position accounts. See SECURITY.md |
| Swap fees of those positions | the Launch PDA's USDC account (the vault) | Meteora DLMM: a claim can only be sent by the operator and only pays the fee owner |
| Upkeep (`collect_tax`, `convert_tax`, `rebalance`, `deploy`, `deleverage`) | nobody: open to any wallet | none of them takes an amount, a price or a destination from the caller, and none pays the caller |
| Treasury | a wallet named in the config | receives the platform fee inside `convert_tax` and residual USDC of finished launches; signs nothing |
| Admin | a key named in the config | may rotate admin/treasury, set the platform fee for future launches (at most 20%), list markets and pause; touches no token account or launch |
| Program upgrade authority | the deployer | Solana loader. **Whoever holds it can change every rule above.** See DEPLOYMENT.md. |

## Instructions

| Instruction | Caller | What it does | What the caller controls |
|---|---|---|---|
| `create_launch` | the creator | creates a launch for a mint that passes validation | the token, its tax tier (1% or 3%), its leveraged asset from the listed markets, the supply split disclosure, batch thresholds, the starting reference price |
| `set_pool` | creator, once | records the launch's pool | which pool, as long as it belongs to the configured AMM |
| `register_trader` | anyone | creates the launch's Phoenix trader account | nothing |
| `collect_tax` | anyone | sweeps withheld tax into the vault's tax account | which token accounts to sweep |
| `convert_tax` | anyone | sells one tax batch through the pool; pays the launch's platform fee to the treasury and the rest to the vault | the moment, and the swap route inside the allowlisted AMM; not the size, not the minimum price, not the split, not either destination |
| `rebalance` | anyone | does what the position needs now: above 6x, cuts it to 5.5x; otherwise, unless paused, deposits idle USDC as margin and tops exposure up to 5x when there is no position or leverage is under 4.75x. Succeeds doing nothing when there is nothing safe to do | the moment |
| `deploy` | anyone | the deposit and top-up half of `rebalance`, on its own; fails when there is nothing to do | the moment |
| `deleverage` | anyone, above 6x | the cut half of `rebalance`, on its own; fails when leverage is not above 6x | the moment |
| `redeem` | the holder | burns tokens, frees liquidity if needed, pays USDC | the amount and their minimum payout |
| `pay_claim` | anyone | pays a claim to its owner from idle USDC | nothing |
| `fund_claims` | anyone | re-requests from Phoenix what claims are short of | nothing |
| `unwrap_canonical` | anyone | canonical tokens in the vault to USDC in the vault | nothing |
| `sweep_residual` | anyone | vault USDC to the treasury | only when supply and claims are zero |
| `init_config`, `update_config` | admin | admin and treasury, the platform fee for future launches, pause | no token accounts |
| `add_market` | admin | lists a Phoenix perp market as a leveraged asset | the orderbook must be a Phoenix account and the spline its PDA; tick size and asset id are taken on trust and checked off-chain by `preflight` |

`collect_tax`, `convert_tax` and `rebalance` (or `deploy`) are separate instructions of one
program, so they compose in one transaction, on their own or behind a user's swap.

### What the program checks, whoever calls

The caller is assumed to be anyone, including someone trying to profit. Nothing depends on the
caller being honest or careful.

**`convert_tax`.** The caller supplies the AMM's own swap instruction; the program signs it as the
Tax PDA, which owns nothing but the tax tokens. Then it checks the effect:

- size: the batch is the tax balance capped at `max_convert_tokens`, available only at or above
  `min_convert_tokens` and after the cooldown. The swap must sell at least 90% of that batch and
  no more than declared;
- price: the realized price must be at least the reference price less `max_price_drop_bps` per
  cooldown period elapsed. The reference starts at the pool's launch price (net of fees) and then
  follows a 3:1 running average of conversions;
- destination: the swap pays into the Tax PDA's USDC account, and the program empties it in the
  same instruction: the launch's platform fee (a rate frozen at creation) to a USDC account that
  must belong to the config's treasury, everything else to the vault.

**`rebalance` and `deploy`.** Take no arguments. See "Position strategy" in ECONOMICS.md. Whether exposure is
added depends only on leverage after the deposit: it is added when there is no position or
leverage is under the launch's minimum (4.75x), and not otherwise. The position's unrealized PnL
plays no part; it is only reported in the event. The order is immediate-or-cancel at a limit the
program sets itself, 0.5% from Phoenix's mark; it aims 2% under 5x, and leverage after the fill
must be at most 5x. The mark must be fresh (updated within 150 slots) for any order.

The two differ in what they do when there is no work. `deploy` returns an error. `rebalance`
returns success and skips what it cannot safely do: with nothing idle and leverage in band it
does nothing; with a stale mark it places no order (a deposit alone still goes in); it does
nothing for an account Phoenix is about to liquidate unless it can cut it, for a trader account
that is not registered or not yet enabled, and, apart from a cut, while the protocol is paused.
That is what lets it ride in a user's transaction.

**The cut (`rebalance` above 6x, or `deleverage`).** Allowed only above 6x or when the account is
liquidatable. The size is `position x (L - 5.5) / L`, computed in the instruction, which brings
leverage down to 5.5x, not all the way to 5x. Nothing is withdrawn.

**`redeem`.** See ECONOMICS.md. The reduction and the withdrawal are sized from the redeemer's own
share and happen in the same instruction as the burn, so nobody can make
the vault move collateral out of Phoenix without burning the tokens that entitle them to it.

## The pool, its liquidity and its fees

None of this is in the terp program. It is done by the frontend with Meteora's SDK, in the order
`scripts/localnet/e2e.ts` ran against the real DLMM program.

1. **Pool.** `createCustomizablePermissionlessLbPair2` with an activation slot in the future and
   `CollectFeeMode.OnlyY` (the swap fee is always charged in USDC), plus `set_pool` in the same
   transaction. The creator's wallet must hold a non-zero balance of both tokens.
2. **Seeding, before activation.** `seedLiquidity` with tokens only: owner = the Launch PDA, fee
   owner = the Launch PDA, operator = the creator's wallet, lock release point = u64 max. The SDK
   cannot build for an off-curve owner, so the instructions are built for a placeholder key and
   rewritten with `retargetInstructions` (`packages/sdk/src/pdas.ts`). One transaction proves the
   owner holds the token (1 atom), then one per position creates it and its bin arrays, then one
   per position deposits. With a 2% bin step and a 50x range that is 1 + 3 + 3 transactions.
3. **Activation.** Trading opens at the slot. Positions for another owner cannot be created after
   it, which is why the order is pool, seed, open.

```
 swap in the pool ──> pool fee (USDC) accrues to the positions ──> stays there until claimed
                                                                        │ claim: sent by the operator
                                                                        │ (the creator's wallet)
                                                                        v
                                             vault USDC account (Launch PDA) = idle USDC, part of E
```

The claim is an ordinary DLMM instruction. DLMM rejects it from any signer but the operator, and
rejects any destination but the fee owner's accounts. Once in the vault, the USDC is treated like
converted tax: it pays claims and redemptions and is deposited by the next `rebalance`. No platform fee applies.

The frontend decides "locked" from the decoded position accounts: every position of the pool
owned by the Launch PDA, its owner, operator, fee owner and lock release point.

## Isolation

- Each launch has its own Launch PDA, hence its own Phoenix trader account, vault USDC account and
  tax accounts. There is no shared pool of collateral.
- Every Phoenix instruction checks that the trader account, vault accounts and market are the
  launch's own, and that the exchange-wide accounts are the ones named by Phoenix's global config.
- Phoenix cross-margin applies within a trader account. Since one account belongs to one launch,
  one launch's loss or liquidation cannot draw on another launch's collateral.
- Tests: `tests-litesvm/tests/isolation.rs`.

## Valuation

`E = idle USDC + canonical tokens + max(0, Phoenix collateral + unrealized PnL + unsettled funding) - claims`

- Collateral is read from the Phoenix trader account. Position, PnL, funding, mark and maintenance
  margin come from one Hawkeye `view_margin_for_asset` CPI for the launch's own asset. A launch
  trades only the market it was created with, so that asset is the whole account.
- The mark is Phoenix's own, the same price Phoenix uses for margin and liquidation. It is not
  derived from the token's pool, so trading the pool cannot move `E`.
- Whenever a position is traded or valued, the mark must have been updated within 150 slots. That
  costs a second view (`view_bbo`).
- Claims are fixed USDC amounts owed to people who already burned their tokens. They are not
  anyone else's equity.
- Tax tokens that are not yet converted are not in `E`.

## Transactions

`rebalance`, `deploy`, `deleverage`, `fund_claims` and `redeem` each need a raised compute budget
(up to 1.4M units) and carry about three dozen accounts. Most are the same Phoenix accounts
every time, so the protocol keeps a shared address lookup table
(`scripts/create-lookup-table.ts`). A table holds addresses only and confers no authority.

Whether a DLMM swap plus sweep, sale and rebalance fits one transaction's compute limit and
size on mainnet is **not measured**. Locally, a token transfer plus `rebalance` fits (a test
runs it); a real swap with all three steps behind it has not been run anywhere. The design does
not depend on the answer: the app simulates and leaves out what does not fit, and the crank
falls back to sending the steps as separate transactions, which the program allows.

## What is mocked, and where

| Thing | Local tests | Mainnet |
|---|---|---|
| Phoenix perps, Ember, Hawkeye | deployed mainnet binaries, local markets and oracle | real |
| Token-2022, SPL Token | real programs | real |
| USDC | fixture mint placed at the mainnet USDC address | real |
| AMM | **mock** (`programs/mock-swap`) in the test suites; the deployed DLMM binary in `scripts/localnet` | Meteora DLMM |
| USDC in `scripts/localnet` | **mock**: mainnet's mint account with the mint authority replaced | real |
| Phoenix onboarding | **simulated** by copying capability flags | Phoenix API |
| Phoenix paying or dropping a queued withdrawal | **simulated** by editing accounts | Phoenix |
| Phoenix liquidating a position | **not simulated**; tests cover the states before and after | Phoenix |
