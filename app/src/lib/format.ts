/** Display helpers. Amounts stay bigint atoms until the final string. */
import {
  DELEVERAGE_TO_BPS,
  MAX_PLATFORM_FEE_BPS,
  MAX_LEVERAGE_BPS,
  MIN_LEVERAGE_BPS,
  TARGET_LEVERAGE_BPS,
  USDC_DECIMALS,
  lotsToUnits,
  type Launch,
} from "@terp/sdk";

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `1234567n, 6` -> `"1.234567"`. Truncates (never rounds up) to `maxFraction` digits. */
export function formatAtoms(amount: bigint, decimals: number, maxFraction = decimals): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const fraction = (abs % scale).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const text = group((abs / scale).toString()) + (fraction ? `.${fraction}` : "");
  return negative && text !== "0" ? `-${text}` : text;
}

/** USDC atoms as dollars, two decimals by default. */
export function formatUsd(amount: bigint, maxFraction = 2): string {
  const text = formatAtoms(amount, USDC_DECIMALS, maxFraction);
  return text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`;
}

/** Parses a decimal string into atoms. `null` when it is not a non-negative number that fits. */
export function parseAtoms(text: string, decimals: number): bigint | null {
  const clean = text.trim().replace(/,/g, "");
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!match || (!match[1] && !match[2])) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  return BigInt(match[1] || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Atoms as a plain decimal string suitable for an input field. */
export function atomsToInput(amount: bigint, decimals: number): string {
  return formatAtoms(amount, decimals).replace(/,/g, "");
}

export function formatBps(bps: bigint | number): string {
  return `${formatAtoms(BigInt(bps), 2)}%`;
}

export function formatLeverage(bps: bigint | number): string {
  return `${formatAtoms(BigInt(bps), 4, 2)}x`;
}

/** A float price for display only. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 6 })}`;
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function shortKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function formatTime(unixSeconds: number | null): string {
  if (unixSeconds === null) return "time unknown";
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** Rough wall-clock duration of a slot count (~0.4s per slot). */
export function formatSlots(slots: bigint, slotMs: number): string {
  const seconds = Number(slots) * (slotMs / 1000);
  if (seconds < 90) return `~${Math.round(seconds)}s`;
  if (seconds < 5400) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} h`;
}

/** When a pool starts trading, in one phrase: `"slot 1,234 (in ~8 min, around 14:05)"`. */
export function formatActivation(
  activation: { type: "slot" | "timestamp"; point: bigint; now: bigint; open: boolean },
  slotMs: number,
): string {
  if (activation.type === "timestamp") return new Date(Number(activation.point) * 1000).toLocaleString();
  const slot = `slot ${group(activation.point.toString())}`;
  if (activation.open) return slot;
  const left = activation.point - activation.now;
  const around = new Date(Date.now() + Number(left) * slotMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${slot} (in ${formatSlots(left, slotMs)}, around ${around})`;
}

/** Base lots of a launch's perp market as an amount of its asset, e.g. `"12.34 SOL"`. Sign is dropped. */
export function formatLots(baseLots: bigint, launch: Launch): string {
  const units = lotsToUnits(baseLots < 0n ? -baseLots : baseLots, launch);
  return `${units.toLocaleString("en-US", { maximumFractionDigits: Math.max(launch.baseLotDecimals, 0) })} ${launch.symbol}`;
}

/**
 * The leverage band of a launch: under the minimum a rebalance buys exposure back up to the
 * target; above the maximum it cuts the position to the deleverage level.
 */
export type LeveragePolicy = Pick<Launch, "minLeverageBps" | "targetLeverageBps" | "maxLeverageBps" | "deleverageToBps">;

/** The protocol's policy, for pages that describe a launch before it exists. A launch carries its own copy. */
export const PROTOCOL_POLICY: LeveragePolicy = {
  minLeverageBps: MIN_LEVERAGE_BPS,
  targetLeverageBps: TARGET_LEVERAGE_BPS,
  maxLeverageBps: MAX_LEVERAGE_BPS,
  deleverageToBps: DELEVERAGE_TO_BPS,
};

/** The leverage policy in a few sentences, with the launch's own numbers. */
export function describePolicy(policy: LeveragePolicy): string {
  const min = formatLeverage(policy.minLeverageBps);
  const target = formatLeverage(policy.targetLeverageBps);
  const max = formatLeverage(policy.maxLeverageBps);
  const deleverageTo = formatLeverage(policy.deleverageToBps);
  return (
    `The vault aims to keep its position open and close to ${target}, whether it is in profit or not. ` +
    `Every rebalance first adds the vault's idle USDC as collateral. If there is then no position, or leverage is under ${min}, it buys exposure back up to ${target}. ` +
    `Between ${min} and ${target} nothing is traded; between ${target} and ${max} tax only adds collateral, which pulls leverage back down. ` +
    `Above ${max} a rebalance cuts the position to ${deleverageTo}. Leverage moves with the market; it is not a constant ${target}.`
  );
}

/**
 * The platform fee in one sentence. `platformFeeBps` is the launch's own rate, or the
 * config's rate for a launch not created yet; `null` when neither is known.
 */
export function describePlatformFee(platformFeeBps: number | null): string {
  const share =
    platformFeeBps === null
      ? `A fixed share set at launch, at most ${formatBps(MAX_PLATFORM_FEE_BPS)},`
      : platformFeeBps === 0
        ? "No part"
        : formatBps(platformFeeBps);
  return `${share} of the USDC each tax sale brings in is paid to the Terp platform treasury as the platform fee; the rest goes to the vault.`;
}

/** What a launch's vault holds by mandate, e.g. `"5x-target BTC long"`. Asset and direction are fixed at launch. */
export function formatMandate(launch: Launch): string {
  return `${formatLeverage(launch.targetLeverageBps)}-target ${launch.symbol} ${launch.direction}`;
}
