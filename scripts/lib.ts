/**
 * Shared plumbing for the operator scripts.
 *
 * Every script that changes chain state goes through `reviewAndSend`: it prints what the
 * transaction does, simulates it, and then sends only after the operator types the confirmation
 * phrase. There is no flag that skips the simulation, and on mainnet no flag that skips the
 * prompt.
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Signer,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
}

export function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~") ? homedir() + path.slice(1) : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolved, "utf8"))));
}

export function connect(): Connection {
  return new Connection(env("RPC_URL"), "confirmed");
}

export async function isMainnet(connection: Connection): Promise<boolean> {
  return (await connection.getGenesisHash()) === MAINNET_GENESIS;
}

export const usdc = (atoms: bigint) => `${(Number(atoms) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`;
export const sol = (lamports: number | bigint) => `${(Number(lamports) / 1e9).toFixed(6)} SOL`;

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export interface Plan {
  title: string;
  /** Plain statements of what the transaction does and what it costs. */
  effects: string[];
  instructions: TransactionInstruction[];
  payer: Keypair;
  signers?: Signer[];
  lookupTables?: AddressLookupTableAccount[];
  computeUnits?: number;
}

/**
 * Prints the plan, simulates it, and sends it only after the operator confirms.
 * Returns the signature, or `null` if the operator declined or `--dry-run` was passed.
 */
export async function reviewAndSend(connection: Connection, plan: Plan): Promise<string | null> {
  const dryRun = process.argv.includes("--dry-run");
  const mainnet = await isMainnet(connection);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: plan.payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnits ?? 400_000 }),
      ...plan.instructions,
    ],
  }).compileToV0Message(plan.lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([plan.payer, ...(plan.signers ?? [])]);

  console.log(`\n=== ${plan.title} ===`);
  console.log(`cluster:   ${mainnet ? "MAINNET-BETA" : "not mainnet"}`);
  console.log(`fee payer: ${plan.payer.publicKey.toBase58()} (${sol(await connection.getBalance(plan.payer.publicKey))})`);
  for (const effect of plan.effects) console.log(`  - ${effect}`);
  console.log(`size:      ${transaction.serialize().length} bytes, ${plan.instructions.length} instruction(s)`);

  const simulation = await connection.simulateTransaction(transaction, { sigVerify: true });
  if (simulation.value.err) {
    console.log(`simulation FAILED: ${JSON.stringify(simulation.value.err)}`);
    for (const line of simulation.value.logs ?? []) console.log(`    ${line}`);
    throw new Error("simulation failed; nothing was sent");
  }
  console.log(`simulation ok, ${simulation.value.unitsConsumed} compute units`);

  if (dryRun) {
    console.log("--dry-run: not sending");
    return null;
  }
  const phrase = mainnet ? "send to mainnet" : "send";
  const answer = await ask(`Type "${phrase}" to sign and send, anything else to abort: `);
  if (answer !== phrase) {
    console.log("aborted; nothing was sent");
    return null;
  }

  const signature = await connection.sendTransaction(transaction, { skipPreflight: false });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
  console.log(`confirmed: ${signature}`);
  return signature;
}

export function pubkeyArg(name: string): PublicKey {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`missing --${name} <pubkey>`);
  return new PublicKey(process.argv[at + 1]);
}

export function stringArg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name} <value>`);
}
