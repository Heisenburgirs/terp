import {
  AuthorityType,
  ExtensionType,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getMintLen,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  createUpdateAuthorityInstruction,
  createUpdateFieldInstruction,
  pack,
  type TokenMetadata,
} from "@solana/spl-token-metadata";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { USDC_MINT } from "./constants";
import { launchPda, tokenAta, usdcAta } from "./pdas";

export interface TokenInfo {
  name: string;
  symbol: string;
  /** URI of the token's metadata JSON (which carries the image). */
  uri: string;
  description: string;
  decimals: number;
  /** Transfer tax in bps: 100 (1%) or 300 (3%). Permanent. */
  transferFeeBps: number;
  /** Fixed total supply, in atoms. */
  totalSupply: bigint;
}

const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * Instructions that create a launch-ready Token-2022 mint in the shape `create_launch` verifies:
 *
 * - a 1% or 3% transfer tax with no cap, no fee authority, and the launch vault as the only
 *   withdraw-withheld authority;
 * - metadata stored on the mint, with its update authority and the pointer authority removed;
 * - the whole supply minted to the creator, then the mint authority removed; no freeze authority.
 *
 * Nothing here can be changed afterwards, by the creator or anyone else. The mint keypair must
 * co-sign the transaction.
 */
export async function buildCreateMintIxs(
  connection: Connection,
  creator: PublicKey,
  mint: PublicKey,
  info: TokenInfo,
  programId?: PublicKey,
): Promise<TransactionInstruction[]> {
  const launch = launchPda(mint, programId);
  const metadata: TokenMetadata = {
    mint,
    name: info.name,
    symbol: info.symbol,
    uri: info.uri,
    additionalMetadata: info.description ? [["description", info.description]] : [],
  };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);
  const creatorAta = tokenAta(creator, mint);

  const ixs = [
    SystemProgram.createAccount({
      fromPubkey: creator,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mint,
      null,
      launch,
      info.transferFeeBps,
      U64_MAX,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMetadataPointerInstruction(mint, null, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, info.decimals, creator, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: creator,
      mint,
      mintAuthority: creator,
      name: info.name,
      symbol: info.symbol,
      uri: info.uri,
    }),
  ];
  if (info.description) {
    ixs.push(
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: creator,
        field: "description",
        value: info.description,
      }),
    );
  }
  ixs.push(
    createUpdateAuthorityInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      oldAuthority: creator,
      newAuthority: null,
    }),
    createAssociatedTokenAccountIdempotentInstruction(creator, creatorAta, creator, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, creatorAta, creator, info.totalSupply, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, creator, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  );
  return ixs;
}

/** Creates `owner`'s associated USDC account if it does not exist yet. */
export function createUsdcAccountIx(payer: PublicKey, owner: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(payer, usdcAta(owner), owner, USDC_MINT);
}
