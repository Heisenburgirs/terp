import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing environment variable ${name}`);
  return value;
};

const expand = (path: string) => (path.startsWith("~") ? homedir() + path.slice(1) : path);

export interface CrankConfig {
  rpcUrl: string;
  /** Any funded wallet: it pays the network fees, has no privileges and holds no funds. */
  keypair: Keypair;
  /**
   * `dry-run` (default) builds and simulates every transaction and sends nothing.
   * `live` signs and sends. It has to be set explicitly.
   */
  mode: "dry-run" | "live";
  intervalMs: number;
  /** Slippage used when building the pool swap. The program enforces its own price floor. */
  swapSlippageBps: number;
  /** Scan for token accounts with withheld fees every this many cycles (the scan is heavy). */
  collectEveryCycles: number;
  /** The protocol's shared address lookup table, if one exists (scripts/create-lookup-table.ts). */
  lookupTable: PublicKey | null;
  stateFile: string;
}

export function loadConfig(): CrankConfig {
  const mode = env("KEEPER_MODE", "dry-run");
  if (mode !== "dry-run" && mode !== "live") throw new Error("KEEPER_MODE must be dry-run or live");
  const table = env("LOOKUP_TABLE", "");
  return {
    rpcUrl: env("RPC_URL"),
    keypair: Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(expand(env("KEEPER_KEYPAIR")), "utf8"))),
    ),
    mode,
    intervalMs: Number(env("KEEPER_INTERVAL_MS", "15000")),
    swapSlippageBps: Number(env("KEEPER_SWAP_SLIPPAGE_BPS", "100")),
    collectEveryCycles: Number(env("KEEPER_COLLECT_EVERY_CYCLES", "20")),
    lookupTable: table ? new PublicKey(table) : null,
    stateFile: expand(env("KEEPER_STATE_FILE", "./crank-state.json")),
  };
}
