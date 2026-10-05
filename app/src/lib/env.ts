import { PublicKey } from "@solana/web3.js";
import { TERP_PROGRAM_ID } from "@terp/sdk";

export const RPC_URL = (process.env.NEXT_PUBLIC_RPC_URL ?? "").trim();
export const CLUSTER = (process.env.NEXT_PUBLIC_CLUSTER ?? "").trim() || "mainnet-beta";

function resolveProgramId(): { programId: PublicKey; error: string | null } {
  const override = (process.env.NEXT_PUBLIC_PROGRAM_ID ?? "").trim();
  if (!override) return { programId: TERP_PROGRAM_ID, error: null };
  try {
    return { programId: new PublicKey(override), error: null };
  } catch {
    return { programId: TERP_PROGRAM_ID, error: "NEXT_PUBLIC_PROGRAM_ID is not a valid public key." };
  }
}

const resolved = resolveProgramId();
export const PROGRAM_ID = resolved.programId;

function resolveLookupTable(): { table: PublicKey | null; error: string | null } {
  const value = (process.env.NEXT_PUBLIC_LOOKUP_TABLE ?? "").trim();
  if (!value) return { table: null, error: null };
  try {
    return { table: new PublicKey(value), error: null };
  } catch {
    return { table: null, error: "NEXT_PUBLIC_LOOKUP_TABLE is not a valid public key." };
  }
}

const lookup = resolveLookupTable();
/**
 * The protocol's shared address lookup table (created with `scripts/create-lookup-table.ts`), or
 * `null` when not configured. Transactions that touch Phoenix usually need it to fit in one packet.
 */
export const LOOKUP_TABLE = lookup.table;

/** Why the app cannot talk to a cluster at all, or `null` when the environment is usable. */
export const ENV_ERROR: string | null = !RPC_URL
  ? "NEXT_PUBLIC_RPC_URL is not set."
  : !/^https?:\/\//.test(RPC_URL)
    ? "NEXT_PUBLIC_RPC_URL must start with http:// or https://."
    : (resolved.error ?? lookup.error);

export function explorerUrl(kind: "tx" | "address", id: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (CLUSTER === "mainnet-beta") return base;
  if (CLUSTER === "devnet" || CLUSTER === "testnet") return `${base}?cluster=${CLUSTER}`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
}
