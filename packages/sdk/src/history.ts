import { BorshCoder, EventParser, type Idl } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { TERP_PROGRAM_ID } from "./constants";
import idl from "./idl/terp.json";

export type HistoryKind =
  | "launchCreated"
  | "poolSet"
  | "traderRegistered"
  | "taxCollected"
  | "taxConverted"
  | "deployed"
  | "deleveraged"
  | "canonicalUnwrapped"
  | "redeemed"
  | "claimsFunded"
  | "claimPaid"
  | "residualSwept";

export interface HistoryEntry {
  kind: HistoryKind;
  signature: string;
  slot: number;
  /** Unix seconds, when the RPC reports it. */
  blockTime: number | null;
  /**
   * Event fields, named as in the program (snake_case, e.g. `usdc_out`, `tokens_burned`).
   * Integers are bigint, keys are strings (base58).
   */
  data: Record<string, bigint | string | boolean | number>;
}

function normalise(value: unknown): bigint | string | boolean | number {
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return value;
  if (value && typeof (value as { toString(): string }).toString === "function") {
    const text = (value as { toString(): string }).toString();
    return /^-?\d+$/.test(text) ? BigInt(text) : text;
  }
  return String(value);
}

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * A launch's history, newest first, rebuilt from the program's events. Every figure is what the
 * program recorded as actually moved, never an estimate.
 */
export async function fetchHistory(
  connection: Connection,
  launch: PublicKey,
  options: { limit?: number; before?: string; programId?: PublicKey } = {},
): Promise<HistoryEntry[]> {
  const programId = options.programId ?? TERP_PROGRAM_ID;
  const parser = new EventParser(programId, new BorshCoder(idl as Idl));
  const signatures = await connection.getSignaturesForAddress(
    launch,
    { limit: options.limit ?? 50, before: options.before },
    "confirmed",
  );
  const successful = signatures.filter((s) => !s.err);
  const entries: HistoryEntry[] = [];

  for (let i = 0; i < successful.length; i += 10) {
    const batch = successful.slice(i, i + 10);
    const transactions = await connection.getTransactions(
      batch.map((s) => s.signature),
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    );
    transactions.forEach((transaction, index) => {
      const logs = transaction?.meta?.logMessages;
      if (!logs) return;
      for (const event of parser.parseLogs(logs)) {
        const data: HistoryEntry["data"] = {};
        for (const [key, value] of Object.entries(event.data as Record<string, unknown>)) {
          data[key] = normalise(value);
        }
        if (data.launch !== undefined && data.launch !== launch.toBase58()) continue;
        entries.push({
          kind: lowerFirst(event.name) as HistoryKind,
          signature: batch[index].signature,
          slot: batch[index].slot,
          blockTime: batch[index].blockTime ?? null,
          data,
        });
      }
    });
  }
  return entries;
}
