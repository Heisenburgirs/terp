import DLMM, { ActivationType } from "@meteora-ag/dlmm";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getTokenMetadata, unpackAccount } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { tokenAta, usdcAta } from "@terp/sdk";

export interface TokenMeta {
  name: string;
  symbol: string;
  uri: string;
  description: string;
}

/** Metadata stored on the Token-2022 mint itself. `null` when the mint carries none. */
export async function fetchTokenMeta(connection: Connection, mint: PublicKey): Promise<TokenMeta | null> {
  const meta = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (!meta) return null;
  const description = meta.additionalMetadata.find(([key]) => key === "description")?.[1] ?? "";
  return { name: meta.name, symbol: meta.symbol, uri: meta.uri, description };
}

/** When the pool starts trading. A pool created by this app activates at a slot; other tooling may use a timestamp. */
export interface Activation {
  type: "slot" | "timestamp";
  /** Slot, or unix seconds, at which swaps open. */
  point: bigint;
  /** The chain's clock in the same unit, as of this read. */
  now: bigint;
  open: boolean;
}

export interface Market {
  dlmm: DLMM;
  activation: Activation;
  /** Whether the launched token is the pool's X token. */
  tokenIsX: boolean;
  /** Price of the active bin, in USDC per whole token. Display only. */
  price: number;
  /** Launched tokens currently held by the pool. */
  tokenReserve: bigint;
  usdcReserve: bigint;
}

export async function fetchMarket(connection: Connection, pool: PublicKey, mint: PublicKey): Promise<Market> {
  const dlmm = await DLMM.create(connection, pool);
  const tokenIsX = dlmm.tokenX.publicKey.equals(mint);
  const xPerY = Number((await dlmm.getActiveBin()).pricePerToken);
  const type = dlmm.lbPair.activationType === ActivationType.Timestamp ? "timestamp" : "slot";
  const point = BigInt(dlmm.lbPair.activationPoint.toString());
  const now = BigInt((type === "slot" ? dlmm.clock.slot : dlmm.clock.unixTimestamp).toString());
  return {
    dlmm,
    activation: { type, point, now, open: now >= point },
    tokenIsX,
    price: tokenIsX ? xPerY : 1 / xPerY,
    tokenReserve: tokenIsX ? dlmm.tokenX.amount : dlmm.tokenY.amount,
    usdcReserve: tokenIsX ? dlmm.tokenY.amount : dlmm.tokenX.amount,
  };
}

export interface Balances {
  usdc: bigint;
  token: bigint;
}

/** USDC and launch-token balances of `owner`'s associated accounts. Missing accounts count as zero. */
export async function fetchBalances(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<Balances> {
  const usdcAccount = usdcAta(owner);
  const tokenAccount = tokenAta(owner, mint);
  const [usdc, token] = await connection.getMultipleAccountsInfo([usdcAccount, tokenAccount], "confirmed");
  return {
    usdc: usdc ? unpackAccount(usdcAccount, usdc, TOKEN_PROGRAM_ID).amount : 0n,
    token: token ? unpackAccount(tokenAccount, token, TOKEN_2022_PROGRAM_ID).amount : 0n,
  };
}

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * Upgrade authority of an upgradeable program, read from its ProgramData account.
 * `{ authority: null }` means the program is immutable; `null` means it could not be determined.
 */
export async function fetchUpgradeAuthority(
  connection: Connection,
  programId: PublicKey,
): Promise<{ authority: PublicKey | null } | null> {
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER);
  const info = await connection.getAccountInfo(programData, { commitment: "confirmed", dataSlice: { offset: 0, length: 45 } });
  // ProgramData: u32 tag (3), u64 slot, Option<Pubkey> authority
  if (!info || info.data.length < 45 || info.data.readUInt32LE(0) !== 3) return null;
  return { authority: info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)) : null };
}
