/**
 * Read-only diagnostic: compute units of each Hawkeye view on live mainnet state, for a trader
 * account passed with --trader. Used to size the compute budget of the vault's instructions.
 */
import {
  HAWKEYE_PROGRAM_ID,
  PHOENIX_GLOBAL_CONFIG,
  PHOENIX_PROGRAM_ID,
  SOL_MARKET,
  fetchExchange,
} from "@terp/sdk";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { connect, pubkeyArg } from "./lib";

const sighash = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);

async function main() {
  const connection = connect();
  const trader = pubkeyArg("trader");
  const payer = pubkeyArg("payer");
  const exchange = await fetchExchange(connection);
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const base = [ro(PHOENIX_PROGRAM_ID), ro(PHOENIX_GLOBAL_CONFIG), ...exchange.tail.map(ro), ro(exchange.perpAssetMap)];
  const asset = Buffer.alloc(8);
  asset.writeUInt32LE(SOL_MARKET.assetId, 0);

  const views: [string, TransactionInstruction][] = [
    ["view_margin", new TransactionInstruction({ programId: HAWKEYE_PROGRAM_ID, keys: [...base, ro(trader)], data: Buffer.from(sighash("global:view_margin")) })],
    ["view_margin_for_asset", new TransactionInstruction({ programId: HAWKEYE_PROGRAM_ID, keys: [...base, ro(trader)], data: Buffer.concat([sighash("global:view_margin_for_asset"), asset]) })],
    ["view_bbo", new TransactionInstruction({ programId: HAWKEYE_PROGRAM_ID, keys: [...base, ro(SOL_MARKET.orderbook), ro(SOL_MARKET.spline)], data: Buffer.from(sighash("global:view_bbo")) })],
  ];
  for (const [name, instruction] of views) {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
    }).compileToV0Message();
    const result = await connection.simulateTransaction(new VersionedTransaction(message), {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    console.log(name, result.value.err ? JSON.stringify(result.value.err) : `${result.value.unitsConsumed} CU`);
  }
  const header = await connection.getAccountInfo(trader);
  console.log("trader data length", header?.data.length, "header collateral", header?.data.readBigInt64LE(88));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
