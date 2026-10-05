# Economics

All formulas are implemented in `programs/terp/src/math.rs`, mirrored in
`packages/sdk/src/math.ts`, and covered by property tests. Divisions round in favour of the vault.

## Definitions

- `S`: the mint's current supply. It includes pool, creator, tax-account and withheld-tax
  balances. Only burning reduces it.
- `q`: tokens actually burned by a redemption.
- `E`: net realizable vault equity in USDC:
  `idle USDC + canonical tokens + max(0, Phoenix collateral + unrealized PnL + unsettled funding) - claims`.
  An underwater Phoenix account counts as zero, not as a debt. Claims are fixed amounts owed to
  holders who already redeemed.

## What a creator chooses, permanently

| Choice | Options |
|---|---|
| Tax tier | 1% or 3% of every transfer |
| Leveraged asset | any Phoenix perp market the protocol has listed |
| Supply and its split | fixed supply; creator share and pool share are disclosed |
| Starting price | stated as a starting market cap (price x supply); the pool starts on the first price bin at or above it |
| Price range | the top of the seeded range, 10x to 100x the starting price (50x by default); not stored on the launch |

The pool's quote asset is USDC, the position is a long that aims at 5x, and the platform fee is the
platform's rate at the time of creation; those are not the creator's choices in this MVP. Nor is
the pool's shape: bin step 2%, base fee 1%, and the SDK's `curvature` 0.6 are constants of the
frontend (`app/src/lib/liquidity.ts`). **Those three numbers and the range bounds are the values
the local test ran with; the product owner has not confirmed them.**

## Initial liquidity

The pool is seeded with **tokens only**. The creator puts in the pool allocation and no USDC.
The tokens are spread over price bins from the starting price up to the top of the range, more
of them near the top. Buyers' USDC fills the bins as the price rises, and the same bins buy the
tokens back when it falls. This is the pool the token trades in from the first trade to the
last: there is no bonding curve that graduates and no migration, and the transfer tax applies
from the first trade.

"Starting market cap $10,000" with a supply of 1,000,000,000 means a starting price of $0.00001.
At that price the pool holds no USDC at all; the market cap is a price times a supply, not money
in the pool.

**The liquidity is locked.** The positions that hold it are owned by the token's vault (the
Launch PDA), with a lock release point of "never". The creator's wallet is their operator: it
deposits the tokens and nothing else. Nobody can withdraw: Meteora refuses a removal by the
operator (`LiquidityLocked`), and the vault program has no instruction that withdraws. See
SECURITY.md for what this does and does not guarantee.

**Seeding pays the transfer tax.** The deposit is a transfer, so the token's own tax applies to
it. The pool receives the whole pool allocation, and `fee / (1 - fee)` of it more leaves the
creator's wallet (about 3.09% for a 3% tax, 1.01% for 1%), withheld as tax in the pool's token
account. So:

```
creator must hold = pool allocation x (1 + fee / (1 - fee)), plus one token atom
```

That tax comes out of the creator allocation, which therefore cannot be zero. It belongs to the
vault like any other tax: it is swept and sold into the pool in batches. A vault
therefore starts with about 3% (or 1%) of the pool allocation in unsold tax tokens, and selling
them is sell pressure from the first conversions on.

**Trading opens a few minutes after the pool is created.** Positions owned by someone other than
the depositor can only be created before a pool is active. The frontend creates the pool with an
activation slot 1,500 slots ahead (about 10 minutes) and all seeding transactions (7 for a 50x
range) have to confirm before it. If they do not, that launch cannot be seeded as locked.

Meteora requires the wallet that creates the pool to hold a non-zero balance of both tokens, so
the creator needs some USDC in the wallet. Any amount; none is deposited.

Pool liquidity is not vault equity. It is not perp collateral and it does not back redemptions.
At launch `E` is zero and redemption value is zero; it grows only as tax is collected and sold,
and as pool fees are claimed (below).

## Pool swap fees

The pool charges its own swap fee, separate from the token's transfer tax. It is always taken in
USDC (`CollectFeeMode.OnlyY`) and accrues to the liquidity positions, which here are the vault's.

- **Where it goes.** The positions' fee owner is the vault. Meteora pays a claim only to the fee
  owner's accounts: for USDC, the vault's USDC account. A claim to any other account is rejected.
  Claimed fees are idle USDC of the vault, so they are part of `E` and are deployed like converted
  tax. No platform fee is taken from them.
- **Who can claim.** Only the positions' operator, which is the creator's wallet. The token page
  shows the unclaimed amount to everyone and a claim button to that wallet. If the creator never
  claims, the fees stay in the positions; they are not lost, and not in `E`.
- **It is not a flat 1%.** Meteora's fee has a variable part that rises with the number of price
  bins a swap crosses. In a thin, early pool one buy crosses many bins: in the local test a
  single buy that crossed about 65 bins paid about 8% in pool fees. Large early buys pay much
  more than the base fee, on top of the transfer tax.

## From a trade to a position

1. Every transfer leaves the token's tax (1% or 3%, fixed at launch) withheld in the
   recipient's token account, in the launched token. This applies on every venue, not only in
   the launch pool. Nothing arrives in USDC automatically.
2. Three steps, open to any wallet, turn it into the position:
   - sweep the withheld tokens into the vault (`collect_tax`),
   - sell a batch into the token's own pool for USDC, once the vault holds at least
     `min_convert_tokens` (`convert_tax`),
   - deposit the USDC on Phoenix, once at least `min_deposit_usdc` is idle, and apply the
     position strategy below (`rebalance`).
3. Nobody is appointed to send them. A buy or sell made through Terp's trade panel carries them
   in the same transaction when there is work and it fits, so trading is what moves tax into the
   position. An open bot, the crank, does the same for tokens nobody trades on Terp's site. A
   trade made elsewhere pays the tax and carries nothing; its tax waits for the next carrier.

Revenue is the USDC the pool actually paid, less the platform fee. It is less than
"volume x tax x price" because the sale itself pays the transfer tax into the pool, pays the
pool's fee, and moves the price. The program counts `tokens_collected`, `tokens_converted`,
`usdc_converted` (what reached the vault) and `platform_fees_paid` from balance changes; those are
what the UI shows.

## Platform fee

The platform fee is the platform's share of each tax sale. It is not payment for running
anything: nobody has to run the market. Inside `convert_tax` the program splits what the pool
paid:

```
platform fee = floor(usdc_out x platform_fee_bps / 10,000)    to the platform treasury
to vault   = usdc_out - platform fee
```

- The rate is in the protocol config and capped by the program at 20% (`MAX_PLATFORM_FEE_BPS`).
  The platform rate is 3% (300 bps), set at `init-config` (its default).
- A launch copies the rate when it is created and keeps it. Changing the config affects only
  launches created afterwards.
- The fee's destination is the config's treasury; whoever calls `convert_tax` cannot name
  another account, and gets none of it.
- It is taken on converted tax only. Nothing is taken from collateral, PnL or redemptions.

The split is of the converted tax, not of the trade: 97% of each sale's USDC goes to the vault and
3% to the platform, whatever the tax tier. With a 3% tax that is about 2.91% of traded value
funding the vault and about 0.09% going to the platform; with a 1% tax, about 0.97% and 0.03%.
All before the sale's own costs.

Selling tax is sell pressure on the token. The tax withheld when the tax itself is sold comes back
to the vault on a later sweep.

**What leaves a vault:** redemption payouts. Nothing else. The platform fee is taken from tax
proceeds before they reach the vault, never from the vault.

**What enters a vault:** converted tax, less the platform fee, and pool swap fees when the creator's
wallet claims them.

## Position strategy

The goal is a position that stays open and close to 5x. The rule is a leverage band; whether the
position is in profit or at a loss plays no part. Every rule is enforced by the program.
`rebalance` applies all of it and takes no arguments; whoever calls it chooses only when.
`deploy` (steps 1 and 2 below) and `deleverage` (the cut) are the same rules as separate
instructions that fail, instead of doing nothing, when there is no work. The examples below say
`deploy`; a `rebalance` does the same.

| Leverage | Launch field | Value |
|---|---|---|
| minimum: under it, exposure is bought back up to target | `min_leverage_bps` | 4.75x |
| target: what a top-up aims for, and its ceiling | `target_leverage_bps` | 5x |
| maximum: above it, anyone may cut the position | `max_leverage_bps` | 6x |
| what a cut reduces leverage to | `deleverage_to_bps` | 5.5x |

On each `deploy`:

1. **Deposit.** All idle USDC above outstanding claims goes onto Phoenix as margin behind the
   existing position. Leverage falls and the liquidation price moves further from the market.
2. **No position, or leverage after the deposit under 4.75x: top up.** Exposure is bought until
   leverage is back at 5x, in profit or not (the order aims 2% under, for the taker fee and
   slippage; leverage after the fill may not exceed 5x).
3. **Between 4.75x and 5x: nothing is traded.** A small drift under target is left alone, so the
   vault does not pay taker fees for tiny adjustments.
4. **Between 5x and 6x: margin only.** This is where the position sits after the asset has
   fallen. Tax pulls leverage back down toward 5x; nothing is bought and nothing is cut.

Separately, **above 6x anyone may `deleverage`**: the program closes exactly the part of the
position that brings leverage down to 5.5x at mark. It stops at 5.5x, not 5x, so less of the loss
is realised; tax margin does the rest.

Example with $1,000 of collateral and SOL at $150:

| Step | SOL | Collateral + PnL | Position | Leverage | What happened |
|---|---|---|---|---|---|
| open | $150 | $1,000 | $5,000 | 5.00x | first deposit: opened at 5x |
| price falls 2% | $147 | $900 | $4,900 | 5.44x | above 5x, under 6x: nothing is bought or cut |
| +$100 tax | $147 | $1,000 | $4,900 | 4.90x | margin only; between 4.75x and 5x nothing is traded |
| +$100 tax | $147 | $1,100 | $4,900 | 4.45x | margin first; leverage is now under 4.75x |
| same `deploy` | $147 | $1,100 | $5,500 | 5.00x | buys $600 of exposure, though SOL is still below the $150 entry |
| price rises 4% | $152.88 | $1,320 | $5,720 | 4.33x | the position gained $220 |
| `deploy`, no new tax | $152.88 | $1,320 | $6,600 | 5.00x | under 4.75x: buys $880 of exposure |

And the cut, from the same opening position when no tax arrives:

| Step | SOL | Collateral + PnL | Position | Leverage | What happened |
|---|---|---|---|---|---|
| open | $150 | $1,000 | $5,000 | 5.00x | |
| price falls 5% | $142.50 | $750 | $4,750 | 6.33x | above 6x |
| `deleverage` | $142.50 | $750 | $4,125 | 5.50x | sells $625 of the position, `4,750 x (6.33 - 5.5) / 6.33`; about $33 of the $250 loss is realised |

A cut all the way to 5x would have sold $1,000 instead of $625. Leverage is exactly 6x after a 4%
fall ($144: $800 behind $4,800), so anything beyond that opens the cut.

(Idealised: no fees or funding, and without the 2% the order aims under 5x.)

| Situation | What happens |
|---|---|
| New vault, no position | `deploy` deposits and opens at 5x |
| Position was closed by redemptions, or liquidated by Phoenix | `deploy` deposits and opens a new position at 5x: a vault with collateral never stays flat |
| Leverage under 4.75x after the deposit, in profit or at a loss | `deploy` tops up to 5x, with or without a new deposit |
| Leverage between 4.75x and 5x | `deploy` deposits only; nothing is traded |
| Leverage between 5x and 6x | `deploy` deposits only; margin pulls leverage back toward 5x |
| The account is liquidatable right now | `deploy` reverts and `rebalance` adds nothing; the tax waits until the position is gone, then the next call opens a new one |
| Leverage above 6x | `rebalance` (or `deleverage`), sent by anyone, cuts the position to 5.5x |

Other rules:

- Every order is immediate-or-cancel, priced 0.5% from Phoenix's mark, and the mark must be at
  most 150 slots old. A partial fill is completed by a later call, while leverage is still under
  4.75x.
- Collateral leaves Phoenix only inside a redemption, together with the redeemer's share of the
  position.

**What this means for risk.**

- *Leverage is held near 5x even below entry.* Exposure is bought back whenever leverage is under
  4.75x, including while the position is below its entry price, so liquidation is never far away:
  roughly a 15–20% adverse move from 5x. Assets more volatile than SOL get there faster.
- *Top-ups compound.* After gains the position is taken back to 5x again and again, at higher
  prices. The average entry rises, and a reversal hits a bigger position at full leverage.
- *Above 6x, cuts realise losses.* A 5x long reaches 6x after a fall of about 4% with no new
  margin. Each `deleverage` sells part of the position at a loss and that loss is realised. In a
  steady decline without enough tax, repeated cuts shrink the position, the same decay leveraged
  tokens have. Cutting to 5.5x instead of 5x realises less each time but leaves less room before
  the next cut.
- *Cuts and margin only help when someone calls.* A cut and a deposit both happen inside a
  `rebalance`, and a `rebalance` happens when a trade on Terp carries one or someone sends one.
  A gap bigger than the cushion, or a stretch with no trades and no bot, can still end in a
  liquidation before either happens.
- *Tax margin only helps if tax arrives.* Tax is the only source of new margin. A fast fall, or a
  token nobody is trading, gets no help. Nothing here prevents a liquidation.
- *A share of tax goes to the platform.* The 3% platform fee never reaches the vault.
- *"5x" is a target, not a constant.* Leverage moves with the market inside the 4.75x to 6x band
  between calls, and outside it until someone acts.

**Collateral is USDC.** Phoenix perps are margined in USDC, so the tax is always sold for USDC,
whatever the leveraged asset is. The vault never holds the asset itself, only a perp on it.

## Redemption

One transaction, sent by the holder. It depends on nobody else.

```
gross          = floor(q x E / S)
redemption fee = ceil(gross x 3%)                              retained in the vault
exit cost      = max( ceil(ceil(notional x q / S) x 0.05%),    the estimate
                      what closing the slice actually cost )   measured in the transaction
payout         = gross - redemption fee - exit cost
```

`notional` is the open perp notional. If the vault's idle USDC does not cover the payout, the same
instruction closes the redeemer's proportional share of the position with a reduce-only order and
withdraws the difference from Phoenix. The cost of that order (taker fee and slippage, measured as
the fall in the Phoenix account's equity across the fill) comes out of the redeemer's payout, never
less than the flat 0.05% estimate. So the holders who stay keep the whole 3% fee and pay nothing
for the exit. A proportional exit leaves leverage where it was.

The preview in the UI shows the estimate; the holder's **minimum payout** bounds the result. If
the payout would be lower, the transaction reverts and nothing happens.

**No double taxation.** A burn is not a transfer, so the token's transfer tax does not apply to
it, and the tokens never leave the holder's account except to be burned. The only charge on a
redemption is the one above.

**Valuation timing.** `S` and `E` are read inside the redeeming transaction, at Phoenix's current
mark. There is no request step and nothing to wait for.

### When the payout is deferred

Phoenix throttles withdrawals exchange-wide. If it queues the withdrawal inside a redemption:

- the tokens are burned and the redeemer's share of the position is closed, as usual;
- whatever idle USDC is available is paid immediately;
- the rest becomes a **claim**: a fixed USDC amount recorded for the holder. Its value does not
  change with the market afterwards, and it is subtracted from `E` so no one else can redeem
  against it and no rebalance can deposit it;
- when Phoenix pays, anyone can call `unwrap_canonical` and `pay_claim`; the money can only go to
  the claim's owner. If Phoenix dropped the withdrawal, anyone can call `fund_claims` to request
  exactly the shortfall again.

Only one withdrawal can be queued per launch. While one is, redemptions that need Phoenix
collateral revert; redemptions covered by idle USDC still work.

### Failure handling

| Situation | Result |
|---|---|
| Payout below the holder's minimum | reverts; nothing burned, nothing sold |
| The order book cannot absorb the holder's share within 0.5% of mark | reverts (`ReductionIncomplete`); retry with a smaller amount or later |
| Mark price older than 150 slots while a position is open | reverts until Phoenix's mark updates |
| Phoenix queues the withdrawal | burn happens, payout becomes a fixed claim |
| A withdrawal is already queued and this redemption needs collateral | reverts until the queued one is paid |
| Phoenix account wiped out | it counts as zero; redemptions continue pro-rata against idle USDC |
| Nobody is sending upkeep (no trades on Terp, no bot) | redemptions are unaffected; tax waits unsold |

**Final redemption.** When `q = S`, the redeemer closes the whole position, takes everything, and
no fee is charged, because nobody is left to retain it for. USDC that reaches the vault after
supply and claims are zero goes to the protocol treasury (`sweep_residual`).

In practice supply rarely reaches zero: tokens in the pool, in the tax account and withheld on
accounts are part of `S` and are not redeemed. Their share of `E` stays in the vault. If
redemptions close the whole position while tokens remain, the retained fees stay as collateral
and the next tax opens a new position on them.

## Behaviour this preserves

Each of these is a test.

- **Proportional redemption alone does not raise backing per remaining token.** With zero fees,
  `(E - payout) / (S - q)` equals `E / S` up to rounding dust that stays in the vault.
- **Retained fees do raise it.** With the 3% fee, backing per remaining token strictly increases,
  and the exit's trading cost is not taken out of it.
- **Future tax is shared by the remaining supply.** It adds to `E` and `S` only shrinks.
- **Buying below redemption value and redeeming is legitimate arbitrage.** It is profitable only
  when the market price is below redemption value by more than the transfer tax on the buy plus
  the redemption charge. It pulls the price towards backing and leaves a fee with the holders.
- **A profitable perp does not make token buyers profitable.** Market price is set in the pool and
  can be above or below redemption value. Someone who buys at a premium to backing can lose while
  the position gains.
- **Liquidation can destroy backing.** `E` falls to idle USDC. Neither principal nor yield is
  guaranteed. Tax that arrives afterwards opens a new position; it does not restore what was lost.

A holder who redeems in two parts receives slightly more than in one, because the second part
shares in the fee retained from the first. Total payout never exceeds the fee-free pro-rata share.
