/**
 * Off-chain mirror of `programs/terp/src/math.rs`. Same formulas, same rounding (always in
 * favour of the vault), bigint throughout. `test/math.test.ts` pins both to the same vectors.
 */
export const BPS = 10_000n;
export const PRICE_SCALE = 1_000_000_000_000n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** `E`: idle USDC + canonical tokens + the Phoenix account at mark, floored at zero. */
export function vaultEquity(idleUsdc: bigint, canonical: bigint, phoenixEquity: bigint): bigint {
  return idleUsdc + canonical + (phoenixEquity > 0n ? phoenixEquity : 0n);
}

/** Leverage in bps. `null` means a position on no equity. */
export function leverageBps(notional: bigint, equity: bigint): bigint | null {
  if (notional === 0n) return 0n;
  if (equity <= 0n) return null;
  return (notional * BPS) / equity;
}

export interface RedemptionQuote {
  /** `floor(q * E / S)` */
  gross: bigint;
  /** Retained in the vault for the remaining holders. */
  redemptionFee: bigint;
  /** Retained in the vault to pay for closing the redeemer's slice of the position. */
  exitCost: bigint;
  payout: bigint;
  /** `q == S`: the last holder takes everything and no fee applies. */
  isFinal: boolean;
}

export function quoteRedemption(
  q: bigint,
  supply: bigint,
  equity: bigint,
  notional: bigint,
  redemptionFeeBps: number,
  exitCostBps: number,
): RedemptionQuote {
  if (supply <= 0n) throw new Error("supply is zero");
  if (q <= 0n) throw new Error("amount is zero");
  if (q > supply) throw new Error("amount exceeds supply");
  if (q === supply) {
    return { gross: equity, redemptionFee: 0n, exitCost: 0n, payout: equity, isFinal: true };
  }
  const gross = (q * equity) / supply;
  const redemptionFee = min(ceilDiv(gross * BigInt(redemptionFeeBps), BPS), gross);
  const sliceNotional = ceilDiv(notional * q, supply);
  const exitCost = min(ceilDiv(sliceNotional * BigInt(exitCostBps), BPS), gross - redemptionFee);
  return {
    gross,
    redemptionFee,
    exitCost,
    payout: gross - redemptionFee - exitCost,
    isFinal: false,
  };
}

/** Limit price the program gives its own IOC orders: `slippageBps` from mark, rounded towards mark. */
export function limitPrice(isBuy: boolean, markTicks: bigint, slippageBps: number): bigint {
  const s = min(BigInt(slippageBps), BPS);
  return isBuy ? (markTicks * (BPS + s)) / BPS : ceilDiv(markTicks * (BPS - s), BPS);
}

/** `floor(amount * bps / 10_000)` */
export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BPS;
}

export function conversionPrice(usdcOut: bigint, tokensIn: bigint): bigint {
  if (tokensIn === 0n) throw new Error("amount is zero");
  return (usdcOut * PRICE_SCALE) / tokensIn;
}

export function conversionPriceFloor(
  emaPrice: bigint,
  maxDropBps: number,
  elapsedSlots: bigint,
  cooldownSlots: bigint,
): bigint {
  let periods = cooldownSlots === 0n ? 1n : elapsedSlots / cooldownSlots;
  if (periods < 1n) periods = 1n;
  const drop = min(BigInt(maxDropBps) * periods, BPS);
  return (emaPrice * (BPS - drop)) / BPS;
}

export function proRataCeil(a: bigint, q: bigint, s: bigint): bigint {
  if (s === 0n) throw new Error("supply is zero");
  return ceilDiv(a * q, s);
}

/** Token-2022 fee withheld on a transfer of `amount`. */
export function transferFee(amount: bigint, feeBps: number): bigint {
  return ceilDiv(amount * BigInt(feeBps), BPS);
}

/** Redemption value of one whole token in USDC atoms, before fees: `E / S`. */
export function redemptionValuePerToken(equity: bigint, supply: bigint, decimals: number): bigint {
  if (supply === 0n) return 0n;
  return (equity * 10n ** BigInt(decimals)) / supply;
}
