/**
 * Read-side Phoenix perps integration: resolves the exchange accounts every instruction needs
 * from the on-chain global configuration, and reads a trader account's margin through Hawkeye
 * (Phoenix's read-only view program) by simulating its view instructions.
 *
 * Layouts follow the public Rise SDK. Nothing here signs or sends.
 */
import {
  AccountMeta,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import {
  HAWKEYE_PROGRAM_ID,
  PHOENIX_API_URL,
  PHOENIX_GLOBAL_CONFIG,
  PHOENIX_PROGRAM_ID,
} from "./constants";
import { leverageBps } from "./math";

export interface Exchange {
  canonicalMint: PublicKey;
  globalVault: PublicKey;
  perpAssetMap: PublicKey;
  withdrawQueue: PublicKey;
  /** `[GTI header, GTI arenas.., ATB header, ATB arenas..]`, the tail of every Phoenix call. */
  tail: PublicKey[];
  /** Slots Phoenix blocks withdrawals for after a deposit. */
  depositCooldownSlots: bigint;
}

const sighash = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);

async function arenas(connection: Connection, header: PublicKey, seed: string): Promise<PublicKey[]> {
  const info = await connection.getAccountInfo(header);
  if (!info || !info.owner.equals(PHOENIX_PROGRAM_ID)) throw new Error(`missing Phoenix ${seed} header`);
  const count = Math.min(info.data.readUInt16LE(52), info.data.readUInt16LE(54));
  const keys = [header];
  for (let i = 1; i < count; i++) {
    keys.push(
      PublicKey.findProgramAddressSync([Buffer.from(seed), Buffer.from([i])], PHOENIX_PROGRAM_ID)[0],
    );
  }
  return keys;
}

/** Reads the exchange-wide accounts from Phoenix's global configuration account. */
export async function fetchExchange(connection: Connection): Promise<Exchange> {
  const info = await connection.getAccountInfo(PHOENIX_GLOBAL_CONFIG);
  if (!info || !info.owner.equals(PHOENIX_PROGRAM_ID)) {
    throw new Error("Phoenix global configuration not found on this cluster");
  }
  const d = info.data;
  const key = (at: number) => new PublicKey(d.subarray(at, at + 32));
  const [gti, atb] = await Promise.all([
    arenas(connection, key(392), "global_trader_index"),
    arenas(connection, key(424), "active_trader_buffer"),
  ]);
  return {
    canonicalMint: key(296),
    globalVault: key(328),
    perpAssetMap: key(360),
    withdrawQueue: key(472),
    tail: [...gti, ...atb],
    // packed after exchange_status u8, quote_decimals u8, withdrawal_margin_factor_bps u16
    depositCooldownSlots: d.readBigUInt64LE(508),
  };
}

export interface TraderHeader {
  authority: PublicKey;
  flags: number;
  /** Phoenix enabled market orders, deposits and withdrawals for this trader. */
  isOnboarded: boolean;
  hasQueuedWithdrawal: boolean;
}

const CAN_PLACE_MARKET = 1 << 2;
const CAN_DEPOSIT = 1 << 4;
const CAN_WITHDRAW = 1 << 5;

export async function fetchTraderHeader(
  connection: Connection,
  traderAccount: PublicKey,
): Promise<TraderHeader | null> {
  const info = await connection.getAccountInfo(traderAccount);
  if (!info || !info.owner.equals(PHOENIX_PROGRAM_ID) || info.data.length < 240) return null;
  const flags = info.data.readUInt32LE(96);
  const ready = CAN_PLACE_MARKET | CAN_DEPOSIT | CAN_WITHDRAW;
  return {
    authority: new PublicKey(info.data.subarray(56, 88)),
    flags,
    isOnboarded: (flags & ready) === ready,
    hasQueuedWithdrawal: info.data.readUInt32LE(108) !== 0,
  };
}

/** A trader account at current mark. Quote lots are USDC atoms. */
export interface PerpView {
  collateral: bigint;
  unrealizedPnl: bigint;
  unsettledFunding: bigint;
  /** collateral + unrealized PnL + unsettled funding */
  equity: bigint;
  withdrawable: bigint;
  maintenanceMargin: bigint;
  isLiquidatable: boolean;
  riskTier: number;
  /** Signed; positive is long. */
  baseLots: bigint;
  notional: bigint;
  entryPrice: bigint;
  markPriceTicks: bigint;
  markPriceSlot: bigint;
  /** `null` when there is a position on no equity. */
  leverageBps: bigint | null;
}

export const EMPTY_PERP_VIEW: PerpView = {
  collateral: 0n,
  unrealizedPnl: 0n,
  unsettledFunding: 0n,
  equity: 0n,
  withdrawable: 0n,
  maintenanceMargin: 0n,
  isLiquidatable: false,
  riskTier: 0,
  baseLots: 0n,
  notional: 0n,
  entryPrice: 0n,
  markPriceTicks: 0n,
  markPriceSlot: 0n,
  leverageBps: 0n,
};

function viewBase(exchange: Exchange): AccountMeta[] {
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return [ro(PHOENIX_PROGRAM_ID), ro(PHOENIX_GLOBAL_CONFIG), ...exchange.tail.map(ro), ro(exchange.perpAssetMap)];
}

/** Compute units the most recent Hawkeye view simulation used. Diagnostic only. */
export let lastViewUnits = 0;

async function simulateView(
  connection: Connection,
  payer: PublicKey,
  instruction: TransactionInstruction,
): Promise<Buffer> {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
  }).compileToV0Message();
  const result = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  const data = result.value.returnData?.data?.[0];
  if (result.value.err || !data) {
    const logs = (result.value.logs ?? []).slice(-4).join(" | ");
    throw new Error(`Hawkeye view failed: ${JSON.stringify(result.value.err)} ${logs}`);
  }
  lastViewUnits = result.value.unitsConsumed ?? 0;
  return Buffer.from(data, "base64");
}

/**
 * Reads margin, position and mark of a trader account. `payer` only has to be an existing
 * funded account; nothing is signed or sent.
 */
export async function fetchPerpView(
  connection: Connection,
  exchange: Exchange,
  market: { assetId: number; orderbook: PublicKey; spline: PublicKey },
  traderAccount: PublicKey,
  payer: PublicKey,
): Promise<PerpView> {
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const base = viewBase(exchange);
  const assetParams = Buffer.alloc(8);
  assetParams.writeUInt32LE(market.assetId, 0);

  const [margin, asset, bbo] = await Promise.all([
    simulateView(
      connection,
      payer,
      new TransactionInstruction({
        programId: HAWKEYE_PROGRAM_ID,
        keys: [...base, ro(traderAccount)],
        data: Buffer.from(sighash("global:view_margin")),
      }),
    ),
    simulateView(
      connection,
      payer,
      new TransactionInstruction({
        programId: HAWKEYE_PROGRAM_ID,
        keys: [...base, ro(traderAccount)],
        data: Buffer.concat([sighash("global:view_margin_for_asset"), assetParams]),
      }),
    ),
    simulateView(
      connection,
      payer,
      new TransactionInstruction({
        programId: HAWKEYE_PROGRAM_ID,
        keys: [...base, ro(market.orderbook), ro(market.spline)],
        data: Buffer.from(sighash("global:view_bbo")),
      }),
    ),
  ]);
  if (margin.length !== 112 || asset.length !== 128 || bbo.length !== 64) {
    throw new Error("unexpected Hawkeye return data");
  }

  const collateral = margin.readBigInt64LE(16);
  const unrealizedPnl = margin.readBigInt64LE(88);
  const unsettledFunding = margin.readBigInt64LE(104);
  const equity = collateral + unrealizedPnl + unsettledFunding;
  const positionValue = asset.readBigInt64LE(56);
  const notional = positionValue < 0n ? -positionValue : positionValue;
  return {
    collateral,
    unrealizedPnl,
    unsettledFunding,
    equity,
    withdrawable: margin.readBigUInt64LE(40),
    maintenanceMargin: margin.readBigUInt64LE(56),
    isLiquidatable: margin[14] !== 0,
    riskTier: margin[13],
    baseLots: asset.readBigInt64LE(24),
    notional,
    entryPrice: asset.readBigUInt64LE(48),
    markPriceTicks: bbo.readBigUInt64LE(32),
    markPriceSlot: bbo.readBigUInt64LE(48),
    leverageBps: leverageBps(notional, equity),
  };
}

/** Mark price of a market and the slot it was last updated, from Hawkeye. Needs no trader. */
export async function fetchMark(
  connection: Connection,
  exchange: Exchange,
  market: { orderbook: PublicKey; spline: PublicKey },
  payer: PublicKey,
): Promise<{ markPriceTicks: bigint; markPriceSlot: bigint; bestBidTicks: bigint; bestAskTicks: bigint }> {
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const bbo = await simulateView(
    connection,
    payer,
    new TransactionInstruction({
      programId: HAWKEYE_PROGRAM_ID,
      keys: [...viewBase(exchange), ro(market.orderbook), ro(market.spline)],
      data: Buffer.from(sighash("global:view_bbo")),
    }),
  );
  if (bbo.length !== 64) throw new Error("unexpected Hawkeye return data");
  return {
    bestBidTicks: bbo.readBigUInt64LE(16),
    bestAskTicks: bbo.readBigUInt64LE(24),
    markPriceTicks: bbo.readBigUInt64LE(32),
    markPriceSlot: bbo.readBigUInt64LE(48),
  };
}

export interface RegisterIxsResponse {
  instructions: {
    programId: string;
    keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: number[];
  }[];
  includeRegisterTrader?: boolean;
  traderOnboarder?: string;
}

/**
 * Phoenix's builder onboarding API. It returns the instructions that enable a trader's
 * capabilities; Phoenix's onboarder co-signs when the transaction is submitted through
 * `submitOnboarding`. The trader authority (a launch PDA here) does not sign.
 */
export async function buildOnboardingIxs(
  traderAuthority: PublicKey,
  feePayer: PublicKey,
  maxPositions = 32,
  apiUrl = PHOENIX_API_URL,
): Promise<{ instructions: TransactionInstruction[]; raw: RegisterIxsResponse }> {
  const response = await fetch(`${apiUrl}/v1/exchange/build-register-ixs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      traderAuthority: traderAuthority.toBase58(),
      txFeePayer: feePayer.toBase58(),
      maxPositions,
    }),
  });
  if (!response.ok) throw new Error(`Phoenix onboarding API: ${response.status} ${await response.text()}`);
  const raw = (await response.json()) as RegisterIxsResponse;
  return {
    raw,
    instructions: raw.instructions.map(
      (ix) =>
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
          data: Buffer.from(ix.data),
        }),
    ),
  };
}

export async function submitOnboarding(
  signedTransactionBase64: string,
  traderAuthority: PublicKey,
  feePayer: PublicKey,
  maxPositions = 32,
  apiUrl = PHOENIX_API_URL,
): Promise<{ signature: string }> {
  const response = await fetch(`${apiUrl}/v1/exchange/send-register-ixs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transaction: signedTransactionBase64,
      traderAuthority: traderAuthority.toBase58(),
      txFeePayer: feePayer.toBase58(),
      maxPositions,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    }),
  });
  if (!response.ok) throw new Error(`Phoenix onboarding API: ${response.status} ${await response.text()}`);
  return (await response.json()) as { signature: string };
}

/** Tick size and lot size of a market; a `Launch` and a `Market` both carry them. */
export interface MarketUnits {
  tickSize: number | bigint;
  baseLotDecimals: number;
}

/** USD price of one unit of the asset at `ticks`. */
export function ticksToUsd(ticks: bigint, market: MarketUnits): number {
  return (Number(ticks) * Number(market.tickSize) * 10 ** market.baseLotDecimals) / 1e6;
}

export function usdToTicks(usd: number, market: MarketUnits): bigint {
  return BigInt(Math.round((usd * 1e6) / (Number(market.tickSize) * 10 ** market.baseLotDecimals)));
}

/** Base lots as a number of whole units of the asset (e.g. SOL). */
export function lotsToUnits(baseLots: bigint, market: MarketUnits): number {
  return Number(baseLots) / 10 ** market.baseLotDecimals;
}
