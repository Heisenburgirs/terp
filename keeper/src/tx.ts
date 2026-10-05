import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KeeperConfig } from "./config";

/** Solana's packet limit for a serialized transaction. */
const MAX_TX_BYTES = 1232;
/** Hawkeye views cost a few hundred thousand compute units each on mainnet. */
const COMPUTE_UNITS = 1_400_000;

export const log = (scope: string, message: string) =>
  console.log(`${new Date().toISOString()} [${scope}] ${message}`);

/** `sent`: confirmed on-chain. `simulated`: dry-run, would have been sent. `failed`: not sent. */
export type Outcome = "sent" | "simulated" | "failed";

interface PersistedState {
  /** Address lookup table per launch, so swap transactions fit in one packet. */
  lookupTables: Record<string, string>;
}

export class Sender {
  private state: PersistedState;
  /** The protocol's shared lookup table; `undefined` until first looked up. */
  private shared: AddressLookupTableAccount | null | undefined;

  constructor(
    readonly connection: Connection,
    readonly config: KeeperConfig,
  ) {
    this.state = existsSync(config.stateFile)
      ? JSON.parse(readFileSync(config.stateFile, "utf8"))
      : { lookupTables: {} };
  }

  private get keeper(): Keypair {
    return this.config.keypair;
  }

  private async build(instructions: TransactionInstruction[], tables: AddressLookupTableAccount[]) {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: this.keeper.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }), ...instructions],
    }).compileToV0Message(tables);
    const transaction = new VersionedTransaction(message);
    transaction.sign([this.keeper]);
    return { transaction, blockhash, lastValidBlockHeight };
  }

  private fits(transaction: VersionedTransaction): boolean {
    try {
      return transaction.serialize().length <= MAX_TX_BYTES;
    } catch {
      return false;
    }
  }

  private async lookupTable(launch: string, addresses: PublicKey[]): Promise<AddressLookupTableAccount | null> {
    const existing = this.state.lookupTables[launch];
    if (existing) {
      const table = (await this.connection.getAddressLookupTable(new PublicKey(existing))).value;
      const known = new Set(table?.state.addresses.map((a) => a.toBase58()));
      const missing = addresses.filter((a) => !known.has(a.toBase58()));
      if (table && missing.length === 0) return table;
      if (table && this.config.mode === "live") {
        const extend = AddressLookupTableProgram.extendLookupTable({
          payer: this.keeper.publicKey,
          authority: this.keeper.publicKey,
          lookupTable: table.key,
          addresses: missing.slice(0, 20),
        });
        await this.sendRaw("lookup-table", [extend], []);
        return null; // usable from the next slot; the action is retried next cycle
      }
      return table;
    }
    if (this.config.mode !== "live") return null;

    const slot = await this.connection.getSlot("finalized");
    const [create, address] = AddressLookupTableProgram.createLookupTable({
      authority: this.keeper.publicKey,
      payer: this.keeper.publicKey,
      recentSlot: slot,
    });
    const extend = AddressLookupTableProgram.extendLookupTable({
      payer: this.keeper.publicKey,
      authority: this.keeper.publicKey,
      lookupTable: address,
      addresses: addresses.slice(0, 20),
    });
    await this.sendRaw("lookup-table", [create, extend], []);
    this.state.lookupTables[launch] = address.toBase58();
    writeFileSync(this.config.stateFile, JSON.stringify(this.state, null, 2));
    log("lookup-table", `created ${address.toBase58()} for launch ${launch}`);
    return null;
  }

  private async sendRaw(
    scope: string,
    instructions: TransactionInstruction[],
    tables: AddressLookupTableAccount[],
  ): Promise<Outcome> {
    const { transaction, blockhash, lastValidBlockHeight } = await this.build(instructions, tables);
    const simulation = await this.connection.simulateTransaction(transaction, { sigVerify: true });
    if (simulation.value.err) {
      const tail = (simulation.value.logs ?? []).slice(-6).join(" | ");
      log(scope, `simulation failed: ${JSON.stringify(simulation.value.err)} ${tail}`);
      return "failed";
    }
    if (this.config.mode !== "live") {
      log(scope, `dry-run ok (${simulation.value.unitsConsumed} CU); not sent`);
      return "simulated";
    }
    const signature = await this.connection.sendTransaction(transaction, { skipPreflight: true });
    const result = await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (result.value.err) {
      log(scope, `failed on-chain: ${signature} ${JSON.stringify(result.value.err)}`);
      return "failed";
    }
    log(scope, `confirmed ${signature} (${simulation.value.unitsConsumed} CU simulated)`);
    return "sent";
  }

  /**
   * Simulates, and in live mode sends, one keeper action. Every transaction is simulated first;
   * one that fails simulation is never sent.
   */
  async send(scope: string, launch: string, what: string, instructions: TransactionInstruction[]): Promise<Outcome> {
    log(scope, what);
    if (this.shared === undefined) {
      this.shared = this.config.lookupTable
        ? (await this.connection.getAddressLookupTable(this.config.lookupTable)).value
        : null;
    }
    let tables: AddressLookupTableAccount[] = this.shared ? [this.shared] : [];
    if (!this.fits((await this.build(instructions, tables)).transaction)) {
      const addresses = [
        ...new Map(
          instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => [k.toBase58(), k]),
        ).values(),
      ].filter((k) => !k.equals(this.keeper.publicKey));
      const table = await this.lookupTable(launch, addresses);
      if (!table) {
        log(scope, "transaction needs an address lookup table; it is created in live mode and used from the next cycle");
        return "failed";
      }
      tables = [...tables, table];
      if (!this.fits((await this.build(instructions, tables)).transaction)) {
        log(scope, "transaction does not fit in one packet even with the lookup table; skipped");
        return "failed";
      }
    }
    return this.sendRaw(scope, instructions, tables);
  }
}
