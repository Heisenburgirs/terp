# Security model and known limitations

This is an unaudited MVP. Do not put more into it than you can afford to lose. The list of known
limitations at the end is part of the model, not an afterthought.

## Trust

| Party | Trusted for | Not able to |
|---|---|---|
| Creator | choosing the token's name, tax tier, leveraged asset, supply split, batch thresholds and starting reference price at creation; seeding the pool as locked, in time (limitations 4, 4b); triggering claims of pool fees into the vault (4a) | change any of them later, mint, freeze, touch vault assets, withdraw the liquidity seeded through the create flow, send pool fees anywhere but the vault |
| Keeper (the operator) | being online, and choosing sensible moments to convert and deploy | choose a trade size or price, sell tax below the floor, keep or redirect proceeds, change the fee split, withdraw collateral, lever above 5x, block redemptions |
| Any wallet | nothing | do more than sweep tax to the vault, deleverage above 6x (to 5.5x, a size the program computes), redeem its own tokens, forward claims to their owners |
| Admin | rotating admin, keeper and treasury; setting the keeper fee for future launches; listing leveraged assets correctly; pausing risk-increasing actions | move funds; set a keeper fee above 20%; change an existing launch's keeper fee or market; change or remove a listing; block deleveraging, redemptions or claim payouts |
| Upgrade authority | everything | nothing is out of reach of a program upgrade |
| Phoenix | custody of collateral, mark price, matching, liquidation, withdrawal queue, onboarding | |
| Meteora | pool custody and swap execution; keeping locked positions locked and paying their fees only to the fee owner | |

The keeper is the operator's hot key. A stolen keeper key lets the thief choose *when* tax is
sold and deployed, within the rules below, and nothing more. The admin can replace it.

## Threats and what answers them

**Manipulated valuation.** `E` uses Phoenix's mark price, not the token's pool, so buying or
selling the token cannot change redemption value. The mark must be at most 150 slots old whenever
a position is valued or traded. Supply is read from the mint in the redeeming instruction.

**Sandwiching a redemption.** A redemption does not trade in the token's pool. Its perp order is
limited to 0.5% from mark, the redeemer pays its actual cost, and their minimum payout bounds the
result.

**Sandwiching a tax conversion.** The keeper chooses when to convert and should not do so into a
manipulated pool. The program does not rely on that: it fixes the batch size and refuses a sale
priced more than `max_price_drop_bps` (per cooldown period elapsed) below a reference price that
starts at the pool's launch price and then follows the running average of conversions. A third
party can still try to move the pool just before the keeper's transaction lands; each leg of that
pays the token's transfer tax and the pool's swap fee on a volume much larger than the capped
batch, and that tax returns to the vault. See limitation 5.

**A compromised or malicious keeper.** It cannot name an amount, a price or a destination in
either of its instructions. Conversion proceeds are split by the program: the launch's fixed
keeper fee to the treasury's USDC account (checked against the config), the rest to the vault.

**The platform raising its own fee.** The keeper fee is capped at 20% in the program, and a
launch keeps the rate it was created with: `update_config` changes it for later launches only.
The admin can also change the treasury address, which redirects future fees of every launch but
not their size. Both are bounded by the upgrade authority caveat below.
`deploy` takes no arguments. The worst it can do is bad timing: converting right after someone
moved the pool (bounded by the price floor and the batch cap), or not acting at all (tax waits).

**Sandwiching the perp order.** `deploy`, `deleverage` and `redeem` place immediate-or-cancel
orders at most 0.5% from Phoenix's mark. Someone resting an order just inside that bound only
fills after everything better priced, and for the redeemer's order the cost is the redeemer's own.

**Making the vault trade for nothing.** Exposure is reduced only inside a redemption that burns
tokens in the same instruction, or by `deleverage` above 6x with a size the program computes
(down to 5.5x, which is still above the 4.75x at which exposure is bought, so a cut cannot be
followed by an immediate top-up). Exposure is added only by `deploy`, only when there is no
position or leverage is under 4.75x, only up to 5x. Between 4.75x and 5x nothing is traded, so
repeated calls cannot make the vault pay taker fees for small drifts.

**The creator pulling liquidity.** A launch made through the create flow has its pool allocation
in DLMM positions owned by the Launch PDA with a lock release point of u64 max. The creator's
wallet is the positions' operator. On a local validator running the deployed DLMM binary, the
operator's attempts to remove the liquidity, with and without closing the position, were rejected
(`LiquidityLocked`); a claim of the pool fees to the creator's own accounts was rejected
(`WithdrawToWrongTokenAccount`); a claim by a wallet that is not the operator was rejected; a
claim by the operator into the vault's accounts succeeded. The Launch PDA can only sign through
this program, which has no instruction that touches a DLMM position. See limitations 4 to 4c for
what this does not cover.

**Double redemption.** Tokens are burned in the instruction that values them. A second redemption
of the same tokens fails because they no longer exist.

**Supply accounting.** `S` is the mint's supply, read at redemption. No instruction mints. Burns
are the only change.

**Unauthorized instructions.** PDAs are derived and checked with seeds. Phoenix accounts are pinned
to the launch and to Phoenix's global configuration. The swap program and its instruction
discriminators are allowlisted and immutable. A test asserts from the IDL that the keeper signs
only `convert_tax` and `deploy`, the admin only config and listing instructions, the creator only
`create_launch` and `set_pool`, and that redemption and the safety instructions need none of them.

**Collateral withdrawn without reducing exposure.** Collateral leaves Phoenix in two places.
`redeem` closes the redeemer's proportional share first and requires leverage after the
withdrawal to be no higher than the greater of 5x and what it was. `fund_claims` withdraws only
what claims are short of, for redemptions whose share was already closed, and only while leverage
stays at or under 6x. Withdrawals go only to the vault's own accounts. The keeper has no
withdrawal instruction.

**Claims.** A claim is a fixed amount, subtracted from `E`, excluded from what `deploy` may
deposit, and payable only to its owner.

**Partial fills.** All checks are on state after the fill. An unfilled remainder is cancelled. On
`deploy` leverage is then still under target and a later call completes it if leverage is still
under 4.75x (a remainder that leaves it between 4.75x and 5x is left alone); on `redeem` the
transaction reverts if the reduction was not enough.

**Liquidation.** An underwater account contributes zero to `E`. Redemptions continue pro-rata
against what is left. `deploy` refuses to add to an account that is liquidatable; once Phoenix
has liquidated it, the next `deploy` opens a new position with the new tax.

**Keeper outage.** Tax is not converted or deployed, so a position above 5x gets no new margin
and one under 4.75x is not topped up. No tax is lost: withheld tax and swept tax stay where they
are. Redemption, deleveraging above 6x (to 5.5x), sweeping
tax into the vault and claim payouts do not need the keeper.

**Rounding.** Always against the redeemer. Property tests check that backing per remaining token
never falls and that payouts never exceed equity.

**Isolation.** One Phoenix trader account per launch; see ARCHITECTURE.md.

## Known limitations

1. **Unaudited.** No external review has been done.
2. **The program is upgradeable** by its deployer, which overrides every on-chain guarantee. Put
   the upgrade authority behind a multisig with a timelock, or revoke it, before real funds.
3. **`init_config` is first-come.** Initialise immediately after deploying and verify the admin.
4. **The liquidity lock is made by the create flow and shown, not enforced.** A launch made
   through the frontend seeds its pool with tokens only, into positions owned by the vault that
   never unlock; that was verified on a local validator against the real DLMM program (see
   above and FEASIBILITY.md). The terp program does not check any of it: `set_pool` accepts any
   pool of the configured AMM. A launch made with other tooling can have ordinary, withdrawable
   liquidity, or none. The token page reads the pool's positions from chain and says "locked",
   "NOT locked" or "no liquidity yet" accordingly; it is a display, and someone who does not
   use this frontend does not see it. Anyone can add their own unlocked liquidity next to the
   vault's and remove it again. Locked liquidity also cannot be moved if the pool ever needs
   to be: there is no migration path.
4a. **Claiming pool fees depends on the creator's wallet.** Swap fees accrue to the vault's
   positions and only the positions' operator, the creator's wallet, can trigger a claim. DLMM
   pays it only to the vault. If the creator loses the key or never claims, the fees stay in the
   positions: not lost, not redirected, but not vault equity either. Nobody else, the keeper and
   the admin included, can claim them, and the operator cannot be changed by this program.
4b. **Seeding must finish before the pool activates.** Positions owned by the vault can only be
   created while the pool is not yet active. The frontend gives about 10 minutes (1,500 slots)
   between pool creation and activation, and all seeding transactions must confirm inside it.
   If the creator is too slow, or the network is, the pool opens empty or partly seeded and
   cannot be seeded as locked afterwards; the launch's pool cannot be replaced. The frontend
   stops in that case and does not fall back to an unlocked position. The key that derives the
   position addresses lives in the browser session; losing it mid-way (closing the tab) also
   stops the seeding. The local test ran with a 150-slot window, not 1,500; whether DLMM limits
   how far ahead an activation slot may be was not checked.
4c. **These behaviours come from a closed-source program.** DLMM's source is not public. That
   locked liquidity cannot be removed by the operator, that fees go only to the fee owner, that
   only the operator can claim, and that positions for another owner can only be created
   before activation were established by testing against the deployed binary, not by reading
   code. Meteora can upgrade the program and change any of them. Deposits by the operator into
   an existing position after activation were not tested either way.
4d. **A tokens-only pool is thin at first, and the pool parameters are unconfirmed.** The pool
   holds no USDC until buyers bring it. Early trades move the price a lot, and DLMM's variable
   fee makes a swap that crosses many bins expensive (about 8% for one buy across about 65 bins
   in the local test). The vault starts with the tax withheld from the seed deposit, about 3%
   (or 1%) of the pool allocation in tokens, which the keeper sells into that same pool. Bin
   step (2%), base fee (1%), curvature (0.6) and the range (10x to 100x, default 50x) are
   placeholders taken from the local test and have not been confirmed by the product owner.
5. **The conversion price floor is a deterrent, not an oracle.** It decays to zero if no
   conversion happens for `10,000 / max_price_drop_bps` cooldown periods (10 periods at the 10%
   default), for example after a long stretch with tax below the threshold. Then the protection
   is the keeper's own judgement, the cost of moving the pool, and the batch cap. The starting
   reference is chosen by the creator. With a 1% tax, moving the pool is cheaper than with 3%.
6. **Liveness depends on one operator.** There is no fallback that lets someone else convert or
   deploy if the keeper stops for good; the admin has to appoint a new keeper. Holders can always
   redeem.
7. **The position strategy has costs on both sides.** Leverage is held near 5x whether the
   position is in profit or not: whenever it is under 4.75x, exposure is bought back up to 5x,
   even below the entry price. Liquidation is therefore never far away (roughly a 15–20% adverse
   move from 5x; assets more volatile than SOL get there faster). After gains the position is
   re-levered at higher prices, so a reversal hits a bigger position. After a fall the only
   defence between 5x and 6x is margin from new tax, which helps only if tax arrives; above 6x
   (about 4% below a 5x position with no new margin) anyone can cut the position to 5.5x, which
   realises the loss on the part closed, and in a steady decline without enough tax repeated cuts
   shrink the position, the same decay leveraged tokens have. Cuts and margin act only when
   someone calls: a gap bigger than the cushion can still end in liquidation by Phoenix. That is
   the intended policy, not a guarantee of survival. The leverage that decides all of this is
   Phoenix's notional over account equity at its mark.
7a. **The platform takes a share of tax.** The keeper fee (3% of each conversion's USDC at the
   platform's rate; capped at 20%, fixed per launch) never reaches the vault. The platform is paid on conversion volume whether or not the position
   makes money.
8. **The redemption exit cost can exceed the estimate.** The redeemer pays the real cost of
   closing their share, up to the 0.5% order bound on that share's notional (about 2.5% of gross
   at 5x in the worst case). Their minimum payout is the protection.
9. **Unredeemable share.** Tokens in the pool, the tax account and withheld balances count in `S`
   but are never redeemed, so their share of `E` stays in the vault.
10. **Claims can be underfunded.** A claim is fixed in USDC. If the position is wiped out after a
    redemption was queued and before Phoenix pays, the vault may not hold enough to pay it in
    full; it is paid as USDC becomes available, ahead of any equity.
11. **Phoenix dependency.** Phoenix can change parameters, pause, queue or drop withdrawals,
    liquidate or auto-deleverage the position, and upgrade its programs. The program parses a few
    Phoenix account fields by offset (global config, trader header); a layout change would make
    those instructions fail, not misbehave silently, because discriminators and return-data
    versions are checked. A launch that never registered a Phoenix trader redeems against idle
    USDC without calling Phoenix at all. Each launch also needs Phoenix's onboarding once.
12. **Compute budget and transaction size on mainnet are unmeasured** for `deploy`, `redeem` and
    the keeper's combined sweep-sell-deploy transaction. See FEASIBILITY.md.
13. **A queued withdrawal is checked for leverage when requested, not when Phoenix pays it.**
    Limited by allowing one at a time, and by Phoenix dropping withdrawals the account cannot afford.
14. **Tax conversion needs a buyer.** If the pool is empty or the price has collapsed, tax stays
    in tokens and adds nothing to `E`.
15. **Longs only, USDC pools only.** Launches store a direction and the program handles both
    sides, but only longs are configured and tested. The pool's quote asset is always USDC.
16. **A market listing is trusted.** `add_market` checks that the orderbook is a Phoenix account
    and the spline its PDA, but takes the asset id and tick size from the admin. A wrong listing
    would misprice orders and valuations for launches that choose it. `add-market` reads the
    values from Phoenix's API and `preflight` re-checks every listing against it.
17. **Some Phoenix markets close.** Stock and commodity perps have trading hours and price bands;
    outside them the mark can go stale, which blocks deployment and redemptions that need the
    position until it updates. Only crypto markets were exercised in tests (SOL and BTC).
18. **Liquidation by Phoenix is not simulated in tests.** The states before it (a liquidatable
    account is not topped up) and after it (a vault with no position reopens one) are tested; the
    liquidation itself, and how Phoenix leaves the account's collateral balance, is not.
19. **Real DLMM has been exercised locally, not on mainnet; the frontend flows not at all.** Pool
    creation, tokens-only locked seeding, a buy, `collect_tax` and `convert_tax` through a real
    DLMM swap with the keeper fee split, and the removal and claim attempts above were run by
    `scripts/localnet/e2e.ts` on a local validator with the mainnet DLMM binary and a mock USDC
    mint. Nothing has run on mainnet, where pool state, compute and fees differ. The frontend
    builds the same instructions as that script, but its wallet flows (the multi-transaction
    seeding, resuming it after a reload, the fee claim) have not been run in a browser against
    any validator.
