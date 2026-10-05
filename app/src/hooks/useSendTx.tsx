"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { LOOKUP_TABLE, PROGRAM_ID, explorerUrl } from "@/lib/env";
import { errorMessage, explainTransactionError } from "@/lib/errors";
import { formatAtoms } from "@/lib/format";

export interface TxPlan {
  title: string;
  /** What the transaction does and what it moves, in the user's terms. */
  rows: [label: string, value: string][];
  notes?: string[];
  /**
   * Compute-unit limit to request. Required for anything that touches Phoenix (`PHOENIX_COMPUTE_UNITS`)
   * and for swaps wrapped in a program call; the default 200,000 per instruction is not enough.
   */
  computeUnits?: number;
  /** Builds the instructions. `signers` are extra keypairs that co-sign (a new mint, a new position). */
  build: () => Promise<{ instructions: TransactionInstruction[]; signers?: Signer[] }>;
}

type Phase = "preparing" | "ready" | "blocked" | "signing" | "confirming" | "done" | "failed";

interface Review {
  plan: TxPlan;
  phase: Phase;
  /** Lamports the fee payer loses in simulation: rent for new accounts plus the network fee. */
  solCost: bigint | null;
  error: string | null;
  logs: string[];
  signature: string | null;
}

type SendTx = (plan: TxPlan) => Promise<string | null>;

/** One transaction of a batch. */
export interface BatchTx {
  /** What this transaction does, in the user's terms. */
  label: string;
  instructions: TransactionInstruction[];
  signers?: Signer[];
  computeUnits?: number;
}

/**
 * Several transactions that only make sense together and must land in order, reviewed once.
 * Each is sent after the one before it has confirmed.
 */
export interface BatchPlan {
  title: string;
  rows: [label: string, value: string][];
  notes?: string[];
  /** Every transaction must confirm before this slot; nothing is signed or sent once it is too close. */
  deadlineSlot?: number;
  /** What happens at the deadline, for the error message: e.g. "the pool opens for trading". */
  deadlineLabel?: string;
  /** Builds what is still to be sent. Called when the review opens. */
  build: () => Promise<BatchTx[]>;
}

type ItemState = "waiting" | "sending" | "confirming" | "confirmed" | "failed";

interface BatchReview {
  plan: BatchPlan;
  phase: Phase;
  items: { label: string; state: ItemState; signature: string | null }[];
  /** Simulated SOL cost of the first transaction only: the later ones depend on it. */
  solCost: bigint | null;
  error: string | null;
  logs: string[];
}

/** Resolves with how many transactions confirmed, or `null` when the user backed out before anything was signed. */
type SendBatch = (plan: BatchPlan) => Promise<number | null>;

/** Slots allowed per transaction of a batch when checking a deadline (~6 seconds each). */
export const BATCH_SLOTS_PER_TX = 15;

const SendTxContext = createContext<{ send: SendTx; sendBatch: SendBatch } | null>(null);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Compute-unit limit for transactions that touch Phoenix: redeem, deploy, deleverage, fund claims. */
export const PHOENIX_COMPUTE_UNITS = 1_400_000;

type Table = AddressLookupTableAccount | null;

const tables = new WeakMap<Connection, Promise<Table>>();

/** The configured address lookup table, read once per connection. `null` when not configured or not found. */
function loadLookupTable(connection: Connection): Promise<Table> {
  if (!LOOKUP_TABLE) return Promise.resolve(null);
  let pending = tables.get(connection);
  if (!pending) {
    pending = connection.getAddressLookupTable(LOOKUP_TABLE, { commitment: "confirmed" }).then(
      (response) => {
        // not found: ask again next time, the operator may be about to create it
        if (!response.value) tables.delete(connection);
        return response.value;
      },
      (error) => {
        tables.delete(connection);
        throw error;
      },
    );
    tables.set(connection, pending);
  }
  return pending;
}

function tooLarge(table: Table): string {
  const base = `The transaction is larger than the ${PACKET_DATA_SIZE} bytes Solana allows.`;
  if (!LOOKUP_TABLE) {
    return `${base} It needs the protocol's address lookup table, and this app has none configured: NEXT_PUBLIC_LOOKUP_TABLE must be set in the app's environment. The operator creates the table with scripts/create-lookup-table.ts.`;
  }
  if (!table) {
    return `${base} It needs the protocol's address lookup table, but NEXT_PUBLIC_LOOKUP_TABLE (${LOOKUP_TABLE.toBase58()}) does not exist on this cluster. The operator creates the table with scripts/create-lookup-table.ts.`;
  }
  return `${base} It does not fit even with the configured address lookup table (${LOOKUP_TABLE.toBase58()}); the table may be missing addresses and need to be recreated with scripts/create-lookup-table.ts.`;
}

function compile(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[], table: Table) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions });
  const transaction = new VersionedTransaction(message.compileToV0Message(table ? [table] : []));
  let size: number;
  try {
    size = transaction.serialize().length;
  } catch {
    size = Infinity;
  }
  if (size > PACKET_DATA_SIZE) throw new Error(tooLarge(table));
  return transaction;
}

/**
 * The only path by which this app sends a transaction. Opening a review builds and simulates the
 * transaction but sends nothing; the user must then approve it here and again in their wallet.
 */
export function SendTxProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signAllTransactions } = useWallet();
  const [review, setReview] = useState<Review | null>(null);
  const [batch, setBatch] = useState<BatchReview | null>(null);
  const builtBatch = useRef<{ txs: { instructions: TransactionInstruction[]; signers: Signer[] }[]; table: Table } | null>(null);
  const batchResolver = useRef<((confirmed: number | null) => void) | null>(null);
  const batchConfirmed = useRef(0);
  const built = useRef<{ instructions: TransactionInstruction[]; signers: Signer[]; table: Table } | null>(null);
  const resolver = useRef<((signature: string | null) => void) | null>(null);

  const patch = (changes: Partial<Review>) => setReview((current) => current && { ...current, ...changes });

  const open = useCallback<SendTx>(
    (plan) =>
      new Promise((resolve) => {
        resolver.current?.(null);
        resolver.current = resolve;
        built.current = null;
        batchResolver.current?.(null);
        batchResolver.current = null;
        setBatch(null);
        setReview({ plan, phase: "preparing", solCost: null, error: null, logs: [], signature: null });
        if (!publicKey) {
          patch({ phase: "blocked", error: "Connect a wallet first." });
          return;
        }
        (async () => {
          const [{ instructions: planned, signers = [] }, table] = await Promise.all([
            plan.build(),
            loadLookupTable(connection),
          ]);
          const instructions = plan.computeUnits
            ? [ComputeBudgetProgram.setComputeUnitLimit({ units: plan.computeUnits }), ...planned]
            : planned;
          const transaction = compile(publicKey, PublicKey.default.toBase58(), instructions, table);
          const [balance, simulation] = await Promise.all([
            connection.getBalance(publicKey, "confirmed"),
            connection.simulateTransaction(transaction, {
              sigVerify: false,
              replaceRecentBlockhash: true,
              commitment: "confirmed",
              accounts: { encoding: "base64", addresses: [publicKey.toBase58()] },
            }),
          ]);
          const { err, logs, accounts } = simulation.value;
          if (err) {
            patch({
              phase: "blocked",
              error: explainTransactionError(err, logs, instructions, PROGRAM_ID),
              logs: logs ?? [],
            });
            return;
          }
          built.current = { instructions, signers, table };
          const after = accounts?.[0]?.lamports;
          patch({ phase: "ready", solCost: after === undefined ? null : BigInt(balance) - BigInt(after) });
        })().catch((error) => patch({ phase: "blocked", error: errorMessage(error) }));
      }),
    [connection, publicKey],
  );

  const approve = async () => {
    if (!publicKey || !built.current) return;
    const { instructions, signers, table } = built.current;
    let signature: string | null = null;
    try {
      patch({ phase: "signing", error: null });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const transaction = compile(publicKey, blockhash, instructions, table);
      if (signers.length) transaction.sign(signers);
      signature = await sendTransaction(transaction, connection, { preflightCommitment: "confirmed" });
      patch({ phase: "confirming", signature });
      const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (result.value.err) {
        patch({ phase: "failed", error: explainTransactionError(result.value.err, null, instructions, PROGRAM_ID) });
        return;
      }
      patch({ phase: "done" });
    } catch (error) {
      patch({ phase: "failed", signature, error: errorMessage(error) });
    }
  };

  const close = () => {
    resolver.current?.(review?.phase === "done" ? review.signature : null);
    resolver.current = null;
    setReview(null);
  };

  const busy = review?.phase === "signing" || review?.phase === "confirming";

  const patchBatch = (changes: Partial<BatchReview>) => setBatch((current) => current && { ...current, ...changes });
  const patchItem = (index: number, changes: Partial<BatchReview["items"][number]>) =>
    setBatch(
      (current) =>
        current && { ...current, items: current.items.map((item, i) => (i === index ? { ...item, ...changes } : item)) },
    );

  const openBatch = useCallback<SendBatch>(
    (plan) =>
      new Promise((resolve) => {
        resolver.current?.(null);
        resolver.current = null;
        setReview(null);
        batchResolver.current?.(null);
        batchResolver.current = resolve;
        builtBatch.current = null;
        batchConfirmed.current = 0;
        setBatch({ plan, phase: "preparing", items: [], solCost: null, error: null, logs: [] });
        if (!publicKey) {
          patchBatch({ phase: "blocked", error: "Connect a wallet first." });
          return;
        }
        (async () => {
          const [planned, table] = await Promise.all([plan.build(), loadLookupTable(connection)]);
          if (planned.length === 0) {
            patchBatch({ phase: "blocked", error: "Nothing is left to send." });
            return;
          }
          const txs = planned.map((item) => ({
            signers: item.signers ?? [],
            instructions: item.computeUnits
              ? [ComputeBudgetProgram.setComputeUnitLimit({ units: item.computeUnits }), ...item.instructions]
              : item.instructions,
          }));
          const items = planned.map((item) => ({ label: item.label, state: "waiting" as const, signature: null }));
          // every transaction has to fit a packet; only the first can be simulated, the rest build on it
          const [first] = txs.map((tx) => compile(publicKey, PublicKey.default.toBase58(), tx.instructions, table));
          const [balance, simulation] = await Promise.all([
            connection.getBalance(publicKey, "confirmed"),
            connection.simulateTransaction(first, {
              sigVerify: false,
              replaceRecentBlockhash: true,
              commitment: "confirmed",
              accounts: { encoding: "base64", addresses: [publicKey.toBase58()] },
            }),
          ]);
          const { err, logs, accounts } = simulation.value;
          if (err) {
            patchBatch({
              phase: "blocked",
              items,
              error: `Transaction 1 of ${txs.length}: ${explainTransactionError(err, logs, txs[0].instructions, PROGRAM_ID)}`,
              logs: logs ?? [],
            });
            return;
          }
          builtBatch.current = { txs, table };
          const after = accounts?.[0]?.lamports;
          patchBatch({ phase: "ready", items, solCost: after === undefined ? null : BigInt(balance) - BigInt(after) });
        })().catch((error) => patchBatch({ phase: "blocked", error: errorMessage(error) }));
      }),
    [connection, publicKey],
  );

  const approveBatch = async () => {
    if (!publicKey || !builtBatch.current || !batch) return;
    const { txs, table } = builtBatch.current;
    const { deadlineSlot, deadlineLabel } = batch.plan;
    const beforeDeadline = async (remaining: number) => {
      if (deadlineSlot === undefined) return;
      const slot = await connection.getSlot("confirmed");
      if (slot + remaining * BATCH_SLOTS_PER_TX >= deadlineSlot) {
        throw new Error(
          `Stopped: ${deadlineLabel ?? "the deadline is"} at slot ${deadlineSlot} and the chain is at slot ${slot}, which leaves too little time for ${remaining === 1 ? "this transaction" : `${remaining} transactions`}. Nothing further was sent.`,
        );
      }
    };
    let index = 0;
    let sent = false;
    try {
      patchBatch({ phase: "signing", error: null, logs: [] });
      await beforeDeadline(txs.length);
      let { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const prepare = (tx: (typeof txs)[number]) => {
        const transaction = compile(publicKey, blockhash, tx.instructions, table);
        if (tx.signers.length) transaction.sign(tx.signers);
        return transaction;
      };
      // one wallet approval for all of them when the wallet can; otherwise one prompt each
      const signed = signAllTransactions ? await signAllTransactions(txs.map(prepare)) : null;
      patchBatch({ phase: "confirming" });
      for (; index < txs.length; index++) {
        await beforeDeadline(1);
        patchItem(index, { state: "sending" });
        let signature: string;
        if (signed) {
          const raw = signed[index].serialize();
          for (let attempt = 0; ; attempt++) {
            try {
              signature = await connection.sendRawTransaction(raw, { preflightCommitment: "confirmed" });
              break;
            } catch (error) {
              // the RPC node may not have seen the previous transaction yet; the same signed bytes are safe to resend
              if (index === 0 || attempt >= 2) throw error;
              await sleep(1500);
            }
          }
        } else {
          ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed"));
          signature = await sendTransaction(prepare(txs[index]), connection, { preflightCommitment: "confirmed" });
        }
        sent = true;
        patchItem(index, { state: "confirming", signature });
        const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
        if (result.value.err) {
          throw new Error(explainTransactionError(result.value.err, null, txs[index].instructions, PROGRAM_ID));
        }
        patchItem(index, { state: "confirmed" });
        batchConfirmed.current = index + 1;
      }
      patchBatch({ phase: "done" });
    } catch (error) {
      const logs = (error as { logs?: unknown }).logs;
      patchItem(index, { state: "failed" });
      patchBatch({
        phase: "failed",
        error:
          sent || index > 0
            ? `Transaction ${index + 1} of ${txs.length}: ${errorMessage(error)}`
            : `Nothing was sent. ${errorMessage(error)}`,
        logs: Array.isArray(logs) ? (logs as string[]) : [],
      });
    }
  };

  const closeBatch = () => {
    batchResolver.current?.(batch?.phase === "done" || batch?.phase === "failed" ? batchConfirmed.current : null);
    batchResolver.current = null;
    setBatch(null);
  };

  const batchBusy = batch?.phase === "signing" || batch?.phase === "confirming";
  const batchDone = batch ? batch.items.filter((item) => item.state === "confirmed").length : 0;
  const value = useMemo(() => ({ send: open, sendBatch: openBatch }), [open, openBatch]);

  return (
    <SendTxContext.Provider value={value}>
      {children}
      {batch && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={batch.plan.title}>
          <div className="dialog">
            <h2>{batch.plan.title}</h2>
            <dl className="rows">
              {batch.plan.rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              <div>
                <dt>SOL spent by the first transaction (rent + network fee, simulated)</dt>
                <dd>
                  {batch.phase === "preparing"
                    ? "simulating…"
                    : batch.solCost === null
                      ? "unavailable"
                      : `${formatAtoms(batch.solCost, 9)} SOL`}
                </dd>
              </div>
            </dl>
            {batch.items.length > 0 && (
              <>
                <p className="small">
                  <strong>
                    {batch.items.length === 1 ? "1 transaction" : `${batch.items.length} transactions, sent in this order`}
                  </strong>
                  {batch.phase !== "ready" && batch.phase !== "blocked" && ` — ${batchDone} of ${batch.items.length} confirmed`}
                </p>
                <ol className="batch small">
                  {batch.items.map((item, index) => (
                    <li key={index} className={item.state}>
                      <span>{item.label}</span>
                      <span className={item.state === "confirmed" ? "good" : item.state === "failed" ? "bad" : "muted"}>
                        {item.state === "sending" || item.state === "confirming" ? `${item.state}…` : item.state}
                        {item.signature && (
                          <>
                            {" "}
                            <a href={explorerUrl("tx", item.signature)} target="_blank" rel="noreferrer" className="mono">
                              {item.signature.slice(0, 8)}…
                            </a>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {batch.plan.notes?.map((note) => (
              <p key={note} className="muted small">
                {note}
              </p>
            ))}
            {batch.items.length > 1 && (
              <p className="muted small">
                Only the first transaction can be simulated now: each later one builds on the one before it and is
                checked by the RPC node when it is sent. For the same reason your wallet may warn that the later
                transactions fail in its own preview.{" "}
                {signAllTransactions
                  ? "Your wallet is asked to sign all of them in one approval."
                  : "Your wallet cannot sign several at once, so it will ask for each one."}
              </p>
            )}

            <div className="status" role="status" aria-live="polite">
              {batch.phase === "preparing" && <p className="muted">Building and simulating. Nothing has been sent.</p>}
              {batch.phase === "ready" && (
                <p className="muted">
                  Simulation of the first transaction succeeded. Nothing is sent until you approve here and in your
                  wallet.
                </p>
              )}
              {batch.phase === "signing" && <p>Approve in your wallet…</p>}
              {batch.phase === "confirming" && (
                <p>
                  Sending {Math.min(batchDone + 1, batch.items.length)} of {batch.items.length}. Keep this page open.
                </p>
              )}
              {batch.phase === "done" && (
                <p className="good">
                  <strong>
                    {batch.items.length === 1 ? "Confirmed." : `All ${batch.items.length} confirmed.`}
                  </strong>
                </p>
              )}
              {batch.error && (
                <div className="notice bad">
                  <strong>{batch.phase === "blocked" ? "Not sent: simulation failed" : "Stopped"}</strong>
                  <p>{batch.error}</p>
                  {batch.phase === "failed" && batchDone > 0 && (
                    <p>
                      {batchDone} of {batch.items.length} confirmed and stay on chain. Close this and review again to
                      continue with the rest.
                    </p>
                  )}
                  {batch.logs.length > 0 && (
                    <details>
                      <summary>Program logs</summary>
                      <pre>{batch.logs.slice(-12).join("\n")}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>

            <div className="actions">
              <button onClick={closeBatch} disabled={batchBusy}>
                {batch.phase === "preparing" || batch.phase === "ready" ? "Cancel" : "Close"}
              </button>
              {batch.phase === "ready" && (
                <button className="primary" onClick={approveBatch}>
                  Approve and sign in wallet
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {review && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={review.plan.title}>
          <div className="dialog">
            <h2>{review.plan.title}</h2>
            <dl className="rows">
              {review.plan.rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              {review.plan.computeUnits && (
                <div>
                  <dt>Compute-unit limit requested</dt>
                  <dd>{review.plan.computeUnits.toLocaleString("en-US")}</dd>
                </div>
              )}
              <div>
                <dt>SOL spent (rent + network fee, simulated)</dt>
                <dd>
                  {review.phase === "preparing"
                    ? "simulating…"
                    : review.solCost === null
                      ? "unavailable"
                      : `${formatAtoms(review.solCost, 9)} SOL`}
                </dd>
              </div>
            </dl>
            {review.plan.notes?.map((note) => (
              <p key={note} className="muted small">
                {note}
              </p>
            ))}

            <div className="status" role="status" aria-live="polite">
              {review.phase === "preparing" && <p className="muted">Building and simulating. Nothing has been sent.</p>}
              {review.phase === "ready" && (
                <p className="muted">Simulation succeeded. Nothing is sent until you approve here and in your wallet.</p>
              )}
              {review.phase === "signing" && <p>Approve the transaction in your wallet…</p>}
              {review.phase === "confirming" && <p>Sent. Waiting for confirmation…</p>}
              {review.phase === "done" && (
                <p className="good">
                  <strong>Confirmed.</strong>
                </p>
              )}
              {review.error && (
                <div className="notice bad">
                  <strong>{review.phase === "blocked" ? "Not sent: simulation failed" : "Transaction failed"}</strong>
                  <p>{review.error}</p>
                  {review.logs.length > 0 && (
                    <details>
                      <summary>Program logs</summary>
                      <pre>{review.logs.slice(-12).join("\n")}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
            {review.signature && (
              <p className="small">
                Signature:{" "}
                <a href={explorerUrl("tx", review.signature)} target="_blank" rel="noreferrer" className="mono">
                  {review.signature}
                </a>
              </p>
            )}

            <div className="actions">
              <button onClick={close} disabled={busy}>
                {review.phase === "preparing" || review.phase === "ready" ? "Cancel" : "Close"}
              </button>
              {review.phase === "ready" && (
                <button className="primary" onClick={approve}>
                  Approve and sign in wallet
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </SendTxContext.Provider>
  );
}

/**
 * Returns a function that opens the review dialog for a transaction and resolves with its
 * signature once confirmed, or `null` if the user backed out or it failed.
 */
export function useSendTx(): SendTx {
  const context = useContext(SendTxContext);
  if (!context) throw new Error("SendTxProvider is missing");
  return context.send;
}

/**
 * Like `useSendTx`, for a sequence of transactions reviewed once and sent one after another.
 * Resolves with the number that confirmed, or `null` if the user backed out before signing.
 */
export function useSendBatch(): SendBatch {
  const context = useContext(SendTxContext);
  if (!context) throw new Error("SendTxProvider is missing");
  return context.sendBatch;
}
