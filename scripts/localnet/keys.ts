import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LOCALNET_DIR = resolve(import.meta.dirname, "../../.localnet");

/** A test keypair written by `setup.ts`. These keys hold nothing outside the local validator. */
export function loadLocalKey(role: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(LOCALNET_DIR, `${role}.json`), "utf8"))));
}
