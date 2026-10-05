/**
 * LOCAL SIMULATION ONLY. Asks the real Meteora DLMM program (on the local validator) whether it
 * will open a permissionless pool for a transfer-tax mint that ALSO carries an active transfer
 * hook. Result when last run: rejected, "Unsupported mint extension".
 *
 * Nothing here touches mainnet.
 */
import { DLMM_PROGRAM_ID, TERP_PROGRAM_ID, USDC_MINT, createUsdcAccountIx, usdcAta } from "@terp/sdk";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
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
const { ActivationType } = dlmmModule;
const connection = new Connection(process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

async function send(payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer, ...signers]);
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false });
  if (simulation.value.err) {
    const reason = (simulation.value.logs ?? []).filter((l) => /AnchorError|Error Message|failed/.test(l)).slice(-2).join(" | ");
    throw new Error(reason || JSON.stringify(simulation.value.err));
  }
  const signature = await connection.sendTransaction(transaction, { skipPreflight: true });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
}

async function probe(label: string, hookProgram: PublicKey, creator: Keypair) {
  const mintKey = Keypair.generate();
  const mint = mintKey.publicKey;
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.TransferHook]);
  const ata = getAssociatedTokenAddressSync(mint, creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await send(
    creator,
    [
      SystemProgram.createAccount({
        fromPubkey: creator.publicKey,
        newAccountPubkey: mint,
        space: mintLen,
        lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferFeeConfigInstruction(mint, null, creator.publicKey, 300, 2n ** 64n - 1n, TOKEN_2022_PROGRAM_ID),
      createInitializeTransferHookInstruction(mint, creator.publicKey, hookProgram, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint, 6, creator.publicKey, null, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, ata, creator.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(mint, ata, creator.publicKey, 1_000_000_000_000n, [], TOKEN_2022_PROGRAM_ID),
    ],
    [mintKey],
  );
  const activation = new BN((await connection.getSlot("confirmed")) + 500);
  try {
    const createPair = await DLMM.createCustomizablePermissionlessLbPair2(
      connection,
      new BN(200),
      mint,
      USDC_MINT,
      new BN(-1000),
      new BN(100),
      ActivationType.Slot,
      false,
      creator.publicKey,
      activation,
    );
    await send(creator, createPair.instructions);
    console.log(`${label}: pool CREATED`);
  } catch (error: any) {
    console.log(`${label}: pool REJECTED (${String(error.message).slice(0, 300)})`);
  }
}

async function main() {
  if ((await connection.getGenesisHash()) === MAINNET_GENESIS) throw new Error("this is mainnet; the probe never runs there");
  const creator = Keypair.generate();
  const usdcAuthority = loadLocalKey("usdc-authority");
  for (const key of [creator, usdcAuthority]) {
    await connection.confirmTransaction(await connection.requestAirdrop(key.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
  }
  // the pool creator must hold some of both tokens
  await send(usdcAuthority, [
    createUsdcAccountIx(usdcAuthority.publicKey, creator.publicKey),
    createMintToInstruction(USDC_MINT, usdcAta(creator.publicKey), usdcAuthority.publicKey, 1_000_000n),
  ]);
  console.log(`DLMM program ${DLMM_PROGRAM_ID.toBase58()} on the local validator`);
  // any executable program serves as "a hook program" for this question
  await probe("transfer tax + active transfer hook", TERP_PROGRAM_ID, creator);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
