import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PHOENIX_PROGRAM_ID, TERP_PROGRAM_ID, USDC_MINT } from "./constants";

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

export const configPda = (program = TERP_PROGRAM_ID) => pda([Buffer.from("config")], program);

/** The launch account. Also the PDA that owns the vault and is the Phoenix trader authority. */
export const launchPda = (mint: PublicKey, program = TERP_PROGRAM_ID) =>
  pda([Buffer.from("launch"), mint.toBuffer()], program);

/** Signs tax swaps only; owns the tax token account and a pass-through USDC account. */
export const taxAuthorityPda = (launch: PublicKey, program = TERP_PROGRAM_ID) =>
  pda([Buffer.from("tax"), launch.toBuffer()], program);

/** A listed leveraged asset, by Phoenix asset id. */
export const marketPda = (assetId: number, program = TERP_PROGRAM_ID) => {
  const id = Buffer.alloc(4);
  id.writeUInt32LE(assetId);
  return pda([Buffer.from("market"), id], program);
};

/** What a redeemer is still owed when Phoenix queued their withdrawal. */
export const claimPda = (launch: PublicKey, owner: PublicKey, program = TERP_PROGRAM_ID) =>
  pda([Buffer.from("claim"), launch.toBuffer(), owner.toBuffer()], program);

/** Phoenix cross-margin trader account `(0, 0)` of an authority. */
export const traderPda = (authority: PublicKey) =>
  pda([Buffer.from("trader"), authority.toBuffer(), Buffer.from([0, 0])], PHOENIX_PROGRAM_ID);

export const tokenAta = (owner: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

export const usdcAta = (owner: PublicKey) =>
  getAssociatedTokenAddressSync(USDC_MINT, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

export const splAta = (owner: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

export interface LaunchAddresses {
  mint: PublicKey;
  launch: PublicKey;
  taxAuthority: PublicKey;
  taxAccount: PublicKey;
  taxUsdc: PublicKey;
  vaultUsdc: PublicKey;
  traderAccount: PublicKey;
}

export function launchAddresses(mint: PublicKey, program = TERP_PROGRAM_ID): LaunchAddresses {
  const launch = launchPda(mint, program);
  const taxAuthority = taxAuthorityPda(launch, program);
  return {
    mint,
    launch,
    taxAuthority,
    taxAccount: tokenAta(taxAuthority, mint),
    taxUsdc: usdcAta(taxAuthority),
    vaultUsdc: usdcAta(launch),
    traderAccount: traderPda(launch),
  };
}

/**
 * Rewrites instructions built for one set of accounts so that they name another. Used where an
 * AMM SDK can only build for a wallet-owned account and the real owner is a program address.
 */
export function retargetInstructions(
  instructions: TransactionInstruction[],
  pairs: [PublicKey, PublicKey][],
): TransactionInstruction[] {
  return instructions.map(
    (ix) =>
      new TransactionInstruction({
        programId: ix.programId,
        data: ix.data,
        keys: ix.keys.map((key) => {
          const hit = pairs.find(([from]) => from.equals(key.pubkey));
          return hit ? { ...key, pubkey: hit[1] } : key;
        }),
      }),
  );
}
