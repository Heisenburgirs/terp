//! Pure accounting math. No account access, so every rule here is unit- and property-tested
//! off-chain and mirrored one-to-one by `packages/sdk/src/math.ts`.
//!
//! Rounding rule: every division rounds in favour of the vault (i.e. of the remaining holders).

pub const BPS: u128 = 10_000;
/// Fixed-point scale of a conversion price, USDC atoms per token atom.
pub const PRICE_SCALE: u128 = 1_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    ZeroSupply,
    AmountExceedsSupply,
    ZeroAmount,
}

fn mul_div_floor(a: u128, b: u128, d: u128) -> Result<u128, MathError> {
    a.checked_mul(b)
        .and_then(|v| v.checked_div(d))
        .ok_or(MathError::Overflow)
}

fn mul_div_ceil(a: u128, b: u128, d: u128) -> Result<u128, MathError> {
    let n = a.checked_mul(b).ok_or(MathError::Overflow)?;
    if d == 0 {
        return Err(MathError::Overflow);
    }
    Ok(n.div_ceil(d))
}

fn to_u64(v: u128) -> Result<u64, MathError> {
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

/// `E`: net realizable vault equity in USDC atoms.
///
/// `idle_usdc` and `canonical` (Phoenix-wrapped USDC, 1:1) sit in vault-owned token accounts.
/// `phoenix_equity` is collateral + unrealized PnL + unsettled funding of the launch's own Phoenix
/// trader account at mark. A liquidated or underwater account contributes zero, never a negative
/// number: holders cannot owe the vault.
pub fn vault_equity(idle_usdc: u64, canonical: u64, phoenix_equity: i64) -> Result<u64, MathError> {
    let phoenix = if phoenix_equity > 0 {
        phoenix_equity as u64
    } else {
        0
    };
    idle_usdc
        .checked_add(canonical)
        .and_then(|v| v.checked_add(phoenix))
        .ok_or(MathError::Overflow)
}

/// Leverage in bps of `notional` over `equity`. No position is 0, a position on no equity is
/// `u64::MAX`.
pub fn leverage_bps(notional: u64, equity: i64) -> u64 {
    if notional == 0 {
        return 0;
    }
    if equity <= 0 {
        return u64::MAX;
    }
    let v = (notional as u128) * BPS / (equity as u128);
    u64::try_from(v).unwrap_or(u64::MAX)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RedemptionQuote {
    /// `floor(q * E / S)`
    pub gross: u64,
    /// Retained in the vault for the remaining holders.
    pub redemption_fee: u64,
    /// Retained in the vault to pay for closing the redeemer's slice of the position.
    pub exit_cost: u64,
    /// What the redeemer receives.
    pub payout: u64,
    /// True when `q == S`: the last holder takes all equity and no fee is charged, because
    /// there is nobody left to retain it for.
    pub is_final: bool,
}

/// Redemption of `q` tokens out of supply `S` against equity `E`.
///
/// `notional` is the open perp notional; the exit cost is `exit_cost_bps` of the redeemer's
/// proportional slice of it, so exits pay for the trading they cause instead of the remaining
/// holders.
pub fn quote_redemption(
    q: u64,
    supply: u64,
    equity: u64,
    notional: u64,
    redemption_fee_bps: u16,
    exit_cost_bps: u16,
) -> Result<RedemptionQuote, MathError> {
    if supply == 0 {
        return Err(MathError::ZeroSupply);
    }
    if q == 0 {
        return Err(MathError::ZeroAmount);
    }
    if q > supply {
        return Err(MathError::AmountExceedsSupply);
    }
    if q == supply {
        return Ok(RedemptionQuote {
            gross: equity,
            redemption_fee: 0,
            exit_cost: 0,
            payout: equity,
            is_final: true,
        });
    }

    let gross = to_u64(mul_div_floor(q as u128, equity as u128, supply as u128)?)?;
    let redemption_fee = to_u64(mul_div_ceil(
        gross as u128,
        redemption_fee_bps as u128,
        BPS,
    )?)?
    .min(gross);
    let slice_notional = mul_div_ceil(notional as u128, q as u128, supply as u128)?;
    let exit_cost = to_u64(mul_div_ceil(slice_notional, exit_cost_bps as u128, BPS)?)?
        .min(gross - redemption_fee);

    Ok(RedemptionQuote {
        gross,
        redemption_fee,
        exit_cost,
        payout: gross - redemption_fee - exit_cost,
        is_final: false,
    })
}

/// Limit price of an IOC order: `slippage_bps` from mark on the taker's adverse side, rounded
/// towards mark. A buy pays at most `mark * (1 + s)`, a sell accepts at least `mark * (1 - s)`.
pub fn limit_price(is_buy: bool, mark_ticks: u64, slippage_bps: u16) -> u64 {
    let mark = mark_ticks as u128;
    let s = (slippage_bps as u128).min(BPS);
    let limit = if is_buy {
        mark * (BPS + s) / BPS
    } else {
        (mark * (BPS - s)).div_ceil(BPS)
    };
    u64::try_from(limit).unwrap_or(u64::MAX)
}

/// `floor(amount * bps / 10_000)`
pub fn bps_of(amount: u64, bps: u16) -> u64 {
    ((amount as u128) * (bps as u128) / BPS) as u64
}

/// `floor(amount * bps / 10_000)` for multipliers above 100%, such as leverage.
pub fn bps_of_u32(amount: u64, bps: u32) -> Result<u64, MathError> {
    to_u64((amount as u128) * (bps as u128) / BPS)
}

/// Realized price of a tax conversion, scaled by [PRICE_SCALE].
pub fn conversion_price(usdc_out: u64, tokens_in: u64) -> Result<u128, MathError> {
    if tokens_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    mul_div_floor(usdc_out as u128, PRICE_SCALE, tokens_in as u128)
}

/// Lowest acceptable conversion price given the running average of earlier conversions.
///
/// The permitted drop is `max_drop_bps` per elapsed cooldown period, so a real repricing of the
/// token only delays conversions, while one sandwiched block cannot dump the batch.
pub fn conversion_price_floor(
    ema_price: u128,
    max_drop_bps: u16,
    elapsed_slots: u64,
    cooldown_slots: u64,
) -> u128 {
    let periods = if cooldown_slots == 0 {
        1
    } else {
        (elapsed_slots / cooldown_slots).max(1)
    } as u128;
    let drop = (max_drop_bps as u128).saturating_mul(periods).min(BPS);
    ema_price.saturating_mul(BPS - drop) / BPS
}

/// 3:1 exponential average; the first observation seeds it.
pub fn ema_update(ema_price: u128, price: u128) -> u128 {
    if ema_price == 0 {
        price
    } else {
        (ema_price.saturating_mul(3).saturating_add(price)) / 4
    }
}

/// `ceil(a * q / s)`, the redeemer's proportional slice of a position or balance.
pub fn pro_rata_ceil(a: u64, q: u64, s: u64) -> Result<u64, MathError> {
    if s == 0 {
        return Err(MathError::ZeroSupply);
    }
    to_u64(mul_div_ceil(a as u128, q as u128, s as u128)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const FEE: u16 = 300;
    const EXIT: u16 = 5;

    #[test]
    fn worked_example() {
        // 1,000,000 tokens, $10,000 equity, $40,000 notional; redeem 10%.
        let quote = quote_redemption(
            100_000_000_000,
            1_000_000_000_000,
            10_000_000_000,
            40_000_000_000,
            FEE,
            EXIT,
        )
        .unwrap();
        assert_eq!(quote.gross, 1_000_000_000);
        assert_eq!(quote.redemption_fee, 30_000_000);
        assert_eq!(quote.exit_cost, 2_000_000); // 5 bps of the $4,000 slice
        assert_eq!(quote.payout, 968_000_000);
    }

    #[test]
    fn final_redemption_takes_everything_without_fee() {
        let quote = quote_redemption(7, 7, 123_456, 0, FEE, EXIT).unwrap();
        assert!(quote.is_final);
        assert_eq!(quote.payout, 123_456);
        assert_eq!(quote.redemption_fee, 0);
    }

    #[test]
    fn rejects_bad_amounts() {
        assert_eq!(
            quote_redemption(0, 10, 1, 0, FEE, EXIT),
            Err(MathError::ZeroAmount)
        );
        assert_eq!(
            quote_redemption(11, 10, 1, 0, FEE, EXIT),
            Err(MathError::AmountExceedsSupply)
        );
        assert_eq!(
            quote_redemption(1, 0, 1, 0, FEE, EXIT),
            Err(MathError::ZeroSupply)
        );
    }

    #[test]
    fn dust_redemption_pays_zero_not_negative() {
        let quote = quote_redemption(1, 1_000_000_000, 5, 1_000_000, FEE, EXIT).unwrap();
        assert_eq!(quote.gross, 0);
        assert_eq!(quote.payout, 0);
    }

    #[test]
    fn negative_phoenix_equity_counts_as_zero() {
        assert_eq!(vault_equity(100, 5, -1_000).unwrap(), 105);
        assert_eq!(vault_equity(100, 5, 40).unwrap(), 145);
    }

    #[test]
    fn leverage_edges() {
        assert_eq!(leverage_bps(0, 0), 0);
        assert_eq!(leverage_bps(1, 0), u64::MAX);
        assert_eq!(leverage_bps(1, -5), u64::MAX);
        assert_eq!(leverage_bps(5_000, 1_000), 50_000);
    }

    #[test]
    fn limit_price_rounds_towards_mark() {
        assert_eq!(limit_price(true, 10_000, 50), 10_050);
        assert_eq!(limit_price(false, 10_000, 50), 9_950);
        // 12_165 * 1.005 = 12_225.8 -> a buy may not round up past the bound
        assert_eq!(limit_price(true, 12_165, 50), 12_225);
        // 12_165 * 0.995 = 12_104.2 -> a sell may not round down past the bound
        assert_eq!(limit_price(false, 12_165, 50), 12_105);
        assert_eq!(limit_price(false, 0, 50), 0);
    }

    #[test]
    fn bps_helpers() {
        assert_eq!(bps_of(1_000_000, 25), 2_500);
        assert_eq!(bps_of(399, 25), 0);
        assert_eq!(bps_of_u32(1_000_000, 50_000).unwrap(), 5_000_000);
    }

    #[test]
    fn price_floor_loosens_with_time() {
        let ema = 1_000_000u128;
        assert_eq!(conversion_price_floor(ema, 500, 0, 100), 950_000);
        assert_eq!(conversion_price_floor(ema, 500, 199, 100), 950_000);
        assert_eq!(conversion_price_floor(ema, 500, 400, 100), 800_000);
        assert_eq!(conversion_price_floor(ema, 500, 1_000_000, 100), 0);
    }

    proptest! {
        /// A redemption never pays more than the pro-rata share, and never more than the vault holds.
        #[test]
        fn payout_bounded(q in 1u64..=u64::MAX, s in 1u64..=u64::MAX, e in 0u64..=u64::MAX / 2, n in 0u64..=u64::MAX / 2) {
            prop_assume!(q <= s);
            let quote = quote_redemption(q, s, e, n, FEE, EXIT).unwrap();
            prop_assert!(quote.payout <= quote.gross);
            prop_assert!(quote.gross <= e);
            prop_assert_eq!(quote.payout + quote.redemption_fee + quote.exit_cost, quote.gross);
            prop_assert!((quote.gross as u128) * (s as u128) <= (q as u128) * (e as u128));
        }

        /// Backing per remaining token never falls: (E - payout) / (S - q) >= E / S.
        #[test]
        fn remaining_backing_never_decreases(q in 1u64..1_000_000_000_000u64, extra in 1u64..1_000_000_000_000u64, e in 0u64..1_000_000_000_000_000u64, n in 0u64..1_000_000_000_000_000u64) {
            let s = q + extra;
            let quote = quote_redemption(q, s, e, n, FEE, EXIT).unwrap();
            let lhs = ((e - quote.payout) as u128) * (s as u128);
            let rhs = (e as u128) * ((s - q) as u128);
            prop_assert!(lhs >= rhs);
        }

        /// With no fees, redemption is exactly proportional: backing moves by rounding dust only.
        #[test]
        fn proportional_redemption_alone_does_not_raise_backing(q in 1u64..1_000_000_000u64, extra in 1u64..1_000_000_000u64, e in 0u64..1_000_000_000_000u64) {
            let s = q + extra;
            let quote = quote_redemption(q, s, e, 0, 0, 0).unwrap();
            prop_assert_eq!(quote.payout, quote.gross);
            // less than one atom of equity per redeemed token stays behind
            let exact = (q as u128) * (e as u128);
            prop_assert!(exact - (quote.payout as u128) * (s as u128) < s as u128);
        }

        /// The retained fee strictly raises backing whenever it is non-zero.
        #[test]
        fn retained_fee_raises_backing(q in 1_000u64..1_000_000_000u64, extra in 1_000u64..1_000_000_000u64, e in 1_000_000u64..1_000_000_000_000u64) {
            let s = q + extra;
            let quote = quote_redemption(q, s, e, 0, FEE, 0).unwrap();
            prop_assume!(quote.redemption_fee > 0);
            let lhs = ((e - quote.payout) as u128) * (s as u128);
            let rhs = (e as u128) * ((s - q) as u128);
            prop_assert!(lhs > rhs);
        }

        /// Splitting a redemption in two never beats the fee-free pro-rata entitlement of the whole,
        /// and total payouts never exceed equity.
        #[test]
        fn splitting_cannot_extract_more_than_pro_rata(q1 in 1u64..1_000_000_000u64, q2 in 1u64..1_000_000_000u64, extra in 1u64..1_000_000_000u64, e in 0u64..1_000_000_000_000u64) {
            let s = q1 + q2 + extra;
            let first = quote_redemption(q1, s, e, 0, FEE, EXIT).unwrap();
            let second = quote_redemption(q2, s - q1, e - first.payout, 0, FEE, EXIT).unwrap();
            let total = first.payout as u128 + second.payout as u128;
            prop_assert!(total <= e as u128);
            prop_assert!(total * (s as u128) <= ((q1 + q2) as u128) * (e as u128));
        }

        /// Any sequence of redemptions that ends with the full supply drains the vault exactly.
        #[test]
        fn full_exit_drains_exactly(parts in proptest::collection::vec(1u64..1_000_000u64, 1..12), e in 0u64..1_000_000_000_000u64) {
            let mut supply: u64 = parts.iter().sum();
            let mut equity = e;
            for q in parts {
                let quote = quote_redemption(q, supply, equity, 0, FEE, EXIT).unwrap();
                equity -= quote.payout;
                supply -= q;
            }
            prop_assert_eq!(supply, 0);
            prop_assert_eq!(equity, 0);
        }

        #[test]
        fn ema_stays_between_inputs(ema in 1u128..u64::MAX as u128, price in 1u128..u64::MAX as u128) {
            let next = ema_update(ema, price);
            prop_assert!(next >= ema.min(price) && next <= ema.max(price));
        }
    }
}
