import { describe, expect, it } from "vitest";
import {
  bpsOf,
  conversionPriceFloor,
  leverageBps,
  limitPrice,
  quoteRedemption,
  transferFee,
  vaultEquity,
} from "../src/math";

// Same vectors as the Rust unit tests in programs/terp/src/math.rs.
describe("math mirrors the program", () => {
  it("worked example", () => {
    const quote = quoteRedemption(100_000_000_000n, 1_000_000_000_000n, 10_000_000_000n, 40_000_000_000n, 300, 5);
    expect(quote).toEqual({
      gross: 1_000_000_000n,
      redemptionFee: 30_000_000n,
      exitCost: 2_000_000n,
      payout: 968_000_000n,
      isFinal: false,
    });
  });

  it("final redemption takes everything without fee", () => {
    const quote = quoteRedemption(7n, 7n, 123_456n, 0n, 300, 5);
    expect(quote.isFinal).toBe(true);
    expect(quote.payout).toBe(123_456n);
    expect(quote.redemptionFee).toBe(0n);
  });

  it("dust pays zero, never negative", () => {
    const quote = quoteRedemption(1n, 1_000_000_000n, 5n, 1_000_000n, 300, 5);
    expect(quote.gross).toBe(0n);
    expect(quote.payout).toBe(0n);
  });

  it("rejects bad amounts", () => {
    expect(() => quoteRedemption(0n, 10n, 1n, 0n, 300, 5)).toThrow();
    expect(() => quoteRedemption(11n, 10n, 1n, 0n, 300, 5)).toThrow();
    expect(() => quoteRedemption(1n, 0n, 1n, 0n, 300, 5)).toThrow();
  });

  it("negative Phoenix equity counts as zero", () => {
    expect(vaultEquity(100n, 5n, -1_000n)).toBe(105n);
    expect(vaultEquity(100n, 5n, 40n)).toBe(145n);
  });

  it("leverage edges", () => {
    expect(leverageBps(0n, 0n)).toBe(0n);
    expect(leverageBps(1n, 0n)).toBeNull();
    expect(leverageBps(5_000n, 1_000n)).toBe(50_000n);
  });

  it("limit price rounds towards mark", () => {
    expect(limitPrice(true, 10_000n, 50)).toBe(10_050n);
    expect(limitPrice(false, 10_000n, 50)).toBe(9_950n);
    expect(limitPrice(true, 12_165n, 50)).toBe(12_225n);
    expect(limitPrice(false, 12_165n, 50)).toBe(12_105n);
  });

  it("bps helper", () => {
    expect(bpsOf(1_000_000n, 25)).toBe(2_500n);
    expect(bpsOf(399n, 25)).toBe(0n);
  });

  it("price floor loosens with time", () => {
    expect(conversionPriceFloor(1_000_000n, 500, 0n, 100n)).toBe(950_000n);
    expect(conversionPriceFloor(1_000_000n, 500, 400n, 100n)).toBe(800_000n);
    expect(conversionPriceFloor(1_000_000n, 500, 1_000_000n, 100n)).toBe(0n);
  });

  it("backing per remaining token never falls", () => {
    let seed = 12345n;
    const next = (mod: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return (seed % mod) + 1n;
    };
    for (let i = 0; i < 2_000; i++) {
      const q = next(1_000_000_000_000n);
      const s = q + next(1_000_000_000_000n);
      const e = next(1_000_000_000_000_000n);
      const n = next(1_000_000_000_000_000n);
      const quote = quoteRedemption(q, s, e, n, 300, 5);
      expect((e - quote.payout) * s >= e * (s - q)).toBe(true);
      expect(quote.payout + quote.redemptionFee + quote.exitCost).toBe(quote.gross);
    }
  });

  it("transfer fee rounds up like Token-2022", () => {
    expect(transferFee(100n, 300)).toBe(3n);
    expect(transferFee(101n, 300)).toBe(4n);
  });
});
