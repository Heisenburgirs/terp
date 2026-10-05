/**
 * LOCAL SIMULATION ONLY. Asks the real Meteora DLMM program whether a swap can be signed by a
 * DELEGATE of the input token account, with the output paid to an account the signer does not
 * own. That is what a tax sale would look like if the vault's tax account approved the keeper
 * for one batch instead of the program calling the pool itself.
 *
 * Run after `e2e.ts` on the same validator: it reuses the pool and the buyer's tokens from it.
 *   MINT=<mint printed by e2e> pnpm --filter @terp/scripts exec tsx localnet/probe-delegate.ts
 */
import { DLMM_PROGRAM_ID, USDC_MINT, createUsdcAccountIx, retargetInstructions, tokenAta, usdcAta } from "@terp/sdk";
import { TOKEN_2022_PROGRAM_ID, createApproveCheckedInstruction, getAccount } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { createRequire } from "node:module";
import { MAINNET_GENESIS } from "../lib";
import { loadLocalKey } from "./keys";

const dlmmModule = createRequire(import.meta.url)("@meteora-ag/dlmm");
const DLMM = dlmmModule.default ?? dlmmModule;
const { deriveCustomizablePermissionlessLbPair } = dlmmModule;
const connection = new Connection(process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

async function send(payer: Keypair, ixs: TransactionInstruction[]) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false });
  if (simulation.value.err) {
    const reason = (simulation.value.logs ?? []).filter((l) => /AnchorError|Error:|failed/.test(l)).slice(-3).join(" | ");
    throw new Error(reason || JSON.stringify(simulation.value.err));
  }
  const signature = await connection.sendTransaction(transaction, { skipPreflight: true });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
}

async function main() {
  if ((await connection.getGenesisHash()) === MAINNET_GENESIS) throw new Error("this is mainnet; the probe never runs there");
  const mint = new PublicKey(process.env.MINT!);
  const [buyer, keeper, treasury] = ["buyer", "keeper", "treasury"].map(loadLocalKey);
  const [pool] = deriveCustomizablePermissionlessLbPair(mint, USDC_MINT, DLMM_PROGRAM_ID);
  const dlmm = await DLMM.create(connection, pool);

  const amount = new BN(1_000_000_000);
  const source = tokenAta(buyer.publicKey, mint);
  const destination = usdcAta(treasury.publicKey); // owned by neither the signer nor the token owner
  await send(buyer, [
    createApproveCheckedInstruction(source, mint, keeper.publicKey, buyer.publicKey, BigInt(amount.toString()), 6, [], TOKEN_2022_PROGRAM_ID),
  ]);

  const arrays = await dlmm.getBinArrayForSwap(true);
  const quote = dlmm.swapQuote(amount, true, new BN(100), arrays);
  const swap = await dlmm.swap({
    inToken: mint,
    outToken: USDC_MINT,
    inAmount: amount,
    minOutAmount: quote.minOutAmount,
    lbPair: pool,
    user: keeper.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  const ixs = retargetInstructions(
    (swap.instructions as TransactionInstruction[]).filter((ix) => ix.programId.equals(DLMM_PROGRAM_ID)),
    [
      [tokenAta(keeper.publicKey, mint), source],
      [usdcAta(keeper.publicKey), destination],
    ],
  );
  const before = [(await getAccount(connection, source, "confirmed", TOKEN_2022_PROGRAM_ID)).amount, (await getAccount(connection, destination)).amount];
  try {
    await send(keeper, [createUsdcAccountIx(keeper.publicKey, treasury.publicKey), ...ixs]);
    const after = [(await getAccount(connection, source, "confirmed", TOKEN_2022_PROGRAM_ID)).amount, (await getAccount(connection, destination)).amount];
    console.log(`delegate swap ACCEPTED: source ${before[0] - after[0]} token atoms out, destination +${after[1] - before[1]} USDC atoms`);
  } catch (error: any) {
    console.log(`delegate swap REJECTED: ${String(error.message).slice(0, 400)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
