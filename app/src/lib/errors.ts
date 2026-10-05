import type { PublicKey, TransactionError, TransactionInstruction } from "@solana/web3.js";
import { IDL } from "@terp/sdk";

const PROGRAM_ERRORS = new Map(IDL.errors.map((e) => [e.code, e]));

export function errorMessage(error: unknown): string {
  if (error instanceof RangeError) return "Transaction is too large to fit in one packet.";
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/**
 * Turns a failed simulation or confirmation into one readable sentence: the vault program's own
 * error message when the failing instruction is ours, otherwise whatever the logs say.
 */
export function explainTransactionError(
  err: TransactionError,
  logs: string[] | null | undefined,
  instructions: TransactionInstruction[],
  programId: PublicKey,
): string {
  const instructionError =
    typeof err === "object" && err !== null && "InstructionError" in err
      ? (err as { InstructionError: [number, unknown] }).InstructionError
      : null;
  if (instructionError) {
    const [index, detail] = instructionError;
    const where = `Instruction ${index + 1} of ${instructions.length}`;
    const custom =
      typeof detail === "object" && detail !== null && "Custom" in detail
        ? (detail as { Custom: number }).Custom
        : null;
    if (custom !== null && instructions[index]?.programId.equals(programId)) {
      const known = PROGRAM_ERRORS.get(custom);
      if (known) return `${where} failed: ${known.msg} (${known.name}, code ${known.code}).`;
    }
    const logged = logs
      ?.map((line) => /Error Message: (.+)$/.exec(line)?.[1] ?? /^Program log: Error: (.+)$/.exec(line)?.[1])
      .filter(Boolean)
      .pop();
    if (logged) return `${where} failed: ${logged}`;
    return `${where} failed: ${custom !== null ? `custom program error ${custom}` : JSON.stringify(detail)}.`;
  }
  return `Transaction failed: ${typeof err === "string" ? err : JSON.stringify(err)}.`;
}
