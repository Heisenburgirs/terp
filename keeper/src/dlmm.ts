/**
 * Builds the Meteora DLMM swap that sells tax tokens for USDC.
 *
 * The swap is built for `user` = the launch's tax authority (a PDA), so its token accounts are
 * that PDA's: tax tokens in, USDC out. The keeper never signs the swap itself; `convert_tax`
 * signs for the PDA on-chain and forwards the USDC to the vault.
 */
import { DLMM_PROGRAM_ID, USDC_MINT, type Launch } from "@terp/sdk";
import BN from "bn.js";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createRequire } from "node:module";

// The package's ESM build does not load under Node (it imports a named export its CommonJS
// dependency does not provide), so the CommonJS build is loaded explicitly.
const dlmmModule = createRequire(import.meta.url)("@meteora-ag/dlmm");
const DLMM = dlmmModule.default ?? dlmmModule;

export interface TaxSwap {
  instruction: TransactionInstruction;
  /** Pool quote for the amount, after the token's transfer fee and the pool fee. */
  expectedOut: bigint;
  minOut: bigint;
}

export async function buildTaxSwap(
  connection: Connection,
  launch: Launch,
  taxAuthority: PublicKey,
  amount: bigint,
  slippageBps: number,
): Promise<TaxSwap> {
  if (!launch.pool) throw new Error("launch has no pool");
  const pool = await DLMM.create(connection, launch.pool);
  const swapForY = (pool.lbPair.tokenXMint as PublicKey).equals(launch.mint);
  const inAmount = new BN(amount.toString());
  const binArrays = await pool.getBinArrayForSwap(swapForY);
  const quote = pool.swapQuote(inAmount, swapForY, new BN(slippageBps), binArrays);

  const transaction = await pool.swap({
    inToken: launch.mint,
    outToken: USDC_MINT,
    inAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: launch.pool,
    user: taxAuthority,
    binArraysPubkey: quote.binArraysPubkey,
  });
  const swaps = (transaction.instructions as TransactionInstruction[]).filter((ix) =>
    ix.programId.equals(DLMM_PROGRAM_ID),
  );
  if (swaps.length !== 1) throw new Error(`expected one DLMM instruction, got ${swaps.length}`);
  return {
    instruction: swaps[0],
    expectedOut: BigInt(quote.outAmount.toString()),
    minOut: BigInt(quote.minOutAmount.toString()),
  };
}
