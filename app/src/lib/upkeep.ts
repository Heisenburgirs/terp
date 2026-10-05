/**
 * Vault upkeep that rides along in a user's trade.
 *
 * No wallet has a special role in the protocol: selling tax, sweeping it and adjusting the
 * position are instructions any wallet can send, and the program fixes every amount, price and
 * destination. This app attaches them to trades made through its trade panel, so trading itself
 * turns tax into the position and keeps the position in its band.
 *
 * The user's swap always comes first in the transaction and is never changed. Upkeep is added
 * only if the whole transaction passes simulation, fits in one packet and stays under the
 * compute budget; otherwise steps are left out, down to the plain swap.
 */
import type DLMM from "@meteora-ag/dlmm";
import {
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  DLMM_PROGRAM_ID,
  USDC_MINT,
  launchAddresses,
  math,
  tokenAta,
  type Launch,
  type TerpClient,
  type VaultState,
} from "@terp/sdk";
import BN from "bn.js";
import type { Market } from "./chain";

/** Tolerance given to the pool swap of a tax sale. The price floor that matters is enforced by the program. */
export const TAX_SWAP_SLIPPAGE_BPS = 100;
/** The most compute a trade with upkeep may use in simulation; above it, upkeep is left out. */
export const UPKEEP_MAX_COMPUTE_UNITS = 1_350_000;
/** The limit requested while simulating: the most one transaction can have. */
const SIMULATION_COMPUTE_UNITS = 1_400_000;
/** Token accounts from the withheld-tax scan that a trade sweeps, besides the two its own swap touches. */
export const UPKEEP_SCANNED_SOURCES = 3;

export interface TaxSwap {
  instruction: TransactionInstruction;
  /** Pool quote for the amount, after the token's transfer fee and the pool fee. */
  expectedOut: bigint;
  minOut: bigint;
}

/**
 * The Meteora DLMM swap that sells `amount` tax tokens for USDC, built for `user` = the launch's
 * tax authority (a PDA). Nobody's wallet signs it: `convert_tax` signs for the PDA on-chain and
 * splits the USDC between the vault and the platform treasury. Same construction as the crank's
 * (`keeper/src/dlmm.ts`).
 */
export async function buildTaxSwap(
  market: Market,
  launch: Launch,
  taxAuthority: PublicKey,
  amount: bigint,
  slippageBps = TAX_SWAP_SLIPPAGE_BPS,
): Promise<TaxSwap> {
  const { dlmm, tokenIsX } = market;
  const inAmount = new BN(amount.toString());
  // "swap for Y" means selling the pool's X token; a tax sale sells the launch token
  const binArrays = await dlmm.getBinArrayForSwap(tokenIsX);
  const quote = dlmm.swapQuote(inAmount, tokenIsX, new BN(slippageBps), binArrays);
  const transaction = await dlmm.swap({
    inToken: launch.mint,
    outToken: USDC_MINT,
    inAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: dlmm.pubkey,
    user: taxAuthority,
    binArraysPubkey: quote.binArraysPubkey,
  });
  const swaps = transaction.instructions.filter((ix) => ix.programId.equals(DLMM_PROGRAM_ID));
  if (swaps.length !== 1) throw new Error(`Expected one Meteora DLMM swap instruction, found ${swaps.length}.`);
  return {
    instruction: swaps[0],
    expectedOut: BigInt(quote.outAmount.toString()),
    minOut: BigInt(quote.minOutAmount.toString()),
  };
}

export type UpkeepKind = "convert" | "collect" | "rebalance";

export interface UpkeepStep {
  kind: UpkeepKind;
  instruction: TransactionInstruction;
  /** For the review dialog. */
  label: string;
  detail: string;
}

export interface UpkeepInputs {
  client: TerpClient;
  market: Market;
  state: VaultState;
  paused: boolean;
  /** The platform treasury from the protocol config; `convert_tax` pays the platform fee there. */
  treasury: PublicKey;
  /** The trading wallet: signs and pays the network fee, and is named as `caller`. It receives nothing. */
  payer: PublicKey;
  /** Token accounts the last periodic scan found holding withheld tax. */
  scanned: PublicKey[];
  /** For display: `(atoms) => "1,234 SYM"` and `(atoms) => "$1.23"`. */
  tokens: (atoms: bigint) => string;
  usd: (atoms: bigint) => string;
  leverage: (bps: bigint | number) => string;
}

/**
 * The upkeep there is to do for a vault right now, as steps to append after a swap by `payer`.
 * Each step stands on its own, so any of them can be left out:
 *
 * - convert sells the batch of tax already in the vault's tax account. It comes before the
 *   sweep, because the program fixes the batch from that balance when it runs and a sweep landing
 *   first would change it;
 * - collect sweeps withheld tax into the vault for a later sale. It always names the two token
 *   accounts the user's own swap pays tax into, so there is something to sweep;
 * - rebalance deposits idle USDC, including what the sale just brought in, and tops the position
 *   up or cuts it, or does nothing.
 *
 * A step that cannot be built is skipped: upkeep must never stand in the way of the trade.
 */
export async function planUpkeep(inputs: UpkeepInputs): Promise<UpkeepStep[]> {
  const { client, market, state, paused, treasury, payer, scanned, tokens, usd, leverage } = inputs;
  const { launch } = state;
  const steps: UpkeepStep[] = [];
  const work = client.pendingWork(state, paused);

  let incoming = 0n;
  if (work.convertBatch > 0n) {
    try {
      const batch = work.convertBatch;
      const swap = await buildTaxSwap(
        market,
        launch,
        launchAddresses(launch.mint, client.programId).taxAuthority,
        batch,
      );
      const elapsed = state.slot > launch.lastConvertSlot ? state.slot - launch.lastConvertSlot : 0n;
      const floor = math.conversionPriceFloor(launch.emaPrice, launch.maxPriceDropBps, elapsed, launch.convertCooldownSlots);
      // under the program's floor the sale would be refused; leave it for a better price
      if (swap.minOut > 0n && math.conversionPrice(swap.minOut, batch) >= floor) {
        const fee = math.bpsOf(swap.expectedOut, launch.platformFeeBps);
        incoming = swap.minOut - math.bpsOf(swap.minOut, launch.platformFeeBps);
        steps.push({
          kind: "convert",
          instruction: await client.convertTaxIx(payer, launch, batch, swap.instruction, treasury),
          label: "Also in this transaction: sell a tax batch",
          detail: `${tokens(batch)} of the vault's collected tax, for about ${usd(swap.expectedOut)}: ${usd(swap.expectedOut - fee)} to the vault, ${usd(fee)} platform fee`,
        });
      }
    } catch {
      // no quote or no swap: nothing to sell in this trade
    }
  }

  try {
    const { dlmm, tokenIsX } = market;
    const reserve = tokenIsX ? dlmm.tokenX.reserve : dlmm.tokenY.reserve;
    // a buy leaves its tax in the buyer's token account, a sell in the pool's
    const sources = [tokenAta(payer, launch.mint), reserve];
    for (const account of scanned) {
      if (sources.length >= 2 + UPKEEP_SCANNED_SOURCES) break;
      if (!sources.some((known) => known.equals(account))) sources.push(account);
    }
    steps.push({
      kind: "collect",
      instruction: await client.collectTaxIx(payer, launch, sources),
      label: "Also in this transaction: sweep tax",
      detail: `withheld tax, this trade's included, moves from ${sources.length} token accounts into the vault's tax account`,
    });
  } catch {
    // skipped
  }

  if (launch.traderAccount) {
    try {
      const after = client.pendingWork({ ...state, freeUsdc: state.freeUsdc + incoming }, paused);
      if (after.canRebalance) {
        const detail = after.canDeleverage
          ? `leverage is above ${leverage(launch.maxLeverageBps)}: the vault's position is cut to ${leverage(launch.deleverageToBps)}`
          : after.wouldIncrease
            ? `${after.deployUsdc > 0n ? `about ${usd(after.deployUsdc)} of the vault's USDC is deposited as collateral and ` : ""}the vault's position is topped up to ${leverage(launch.targetLeverageBps)}`
            : `about ${usd(after.deployUsdc)} of the vault's USDC is deposited as collateral; no exposure is added`;
        steps.push({
          kind: "rebalance",
          instruction: await client.rebalanceIx(payer, launch),
          label: "Also in this transaction: rebalance the vault",
          detail,
        });
      }
    } catch {
      // skipped
    }
  }
  return steps;
}

export interface FittedTrade {
  /** What to send, without a compute-unit limit of its own when `computeUnits` is set. */
  instructions: TransactionInstruction[];
  /** Limit to request; `undefined` for the plain swap, which keeps the limit its builder chose. */
  computeUnits: number | undefined;
  attached: UpkeepStep[];
  /** Steps that were ready but did not pass simulation, did not fit, or used too much compute. */
  dropped: UpkeepStep[];
}

const isComputeUnitLimit = (ix: TransactionInstruction) =>
  ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2;

/**
 * Which sets of steps to try, most upkeep first. Leaving a step out goes in this order of
 * preference: the tax sale first (it is the one step that moves the pool price and can lose a
 * race with someone else's sale), then the sweep, then the rebalance.
 */
function candidates(steps: UpkeepStep[]): UpkeepStep[][] {
  const pick = (...kinds: UpkeepKind[]) => steps.filter((step) => kinds.includes(step.kind));
  const all = [
    pick("convert", "collect", "rebalance"),
    pick("collect", "rebalance"),
    pick("convert", "collect"),
    pick("rebalance"),
    pick("collect"),
    pick("convert"),
  ];
  const seen = new Set<string>();
  return all.filter((set) => {
    const key = set.map((step) => step.kind).join("+");
    if (set.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Appends as much of `steps` to `trade` as can be shown to work: each candidate transaction is
 * checked for size and simulated, and the first that succeeds within the compute budget is
 * returned. If none does, or a simulation cannot be run, the result is the plain trade, exactly as
 * it was given.
 */
export async function fitUpkeep(args: {
  connection: Connection;
  payer: PublicKey;
  trade: TransactionInstruction[];
  steps: UpkeepStep[];
  table: AddressLookupTableAccount | null;
}): Promise<FittedTrade> {
  const { connection, payer, trade, steps, table } = args;
  const plain: FittedTrade = { instructions: trade, computeUnits: undefined, attached: [], dropped: steps };
  if (steps.length === 0) return plain;
  // one limit per transaction: the swap builder's own is replaced by ours
  const swap = trade.filter((ix) => !isComputeUnitLimit(ix));

  for (const attached of candidates(steps)) {
    const instructions = [...swap, ...attached.map((step) => step.instruction)];
    try {
      const message = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: SIMULATION_COMPUTE_UNITS }), ...instructions],
      });
      const transaction = new VersionedTransaction(message.compileToV0Message(table ? [table] : []));
      if (transaction.serialize().length > PACKET_DATA_SIZE) continue;
      const { value } = await connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      });
      const units = value.unitsConsumed;
      if (value.err || units === undefined || units > UPKEEP_MAX_COMPUTE_UNITS) continue;
      return {
        instructions,
        // headroom for what changes between simulating and landing
        computeUnits: Math.min(SIMULATION_COMPUTE_UNITS, Math.ceil(units * 1.15) + 25_000),
        attached,
        dropped: steps.filter((step) => !attached.includes(step)),
      };
    } catch {
      // too many accounts to compile, too large to serialize, or the RPC call failed: try less
    }
  }
  return plain;
}
