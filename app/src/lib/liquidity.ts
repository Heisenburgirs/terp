/**
 * The launch pool: its shape, the tokens-only seeding of it, and what the chain says about who
 * owns its liquidity.
 *
 * Mirrors `scripts/localnet/e2e.ts`, which ran this exact sequence against the real Meteora DLMM
 * program on a local validator.
 */
import DLMM, { DEFAULT_BIN_PER_POSITION, getPriceOfBinByBinId, wrapPosition, type LbPosition } from "@meteora-ag/dlmm";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { DLMM_PROGRAM_ID, USDC_DECIMALS, retargetInstructions, tokenAta } from "@terp/sdk";
import BN from "bn.js";
import type { Market } from "./chain";

/**
 * Pool parameters used for every launch created by this app.
 *
 * NOT CONFIRMED BY THE PRODUCT OWNER. These are the values the local end-to-end run used
 * (`scripts/localnet/e2e.ts`); they are placeholders until someone decides them. Changing them
 * changes the number of seeding transactions and the shape of the price curve, nothing else here.
 */
/** Price step between two neighbouring bins. */
export const BIN_STEP_BPS = 200;
/** The pool's base swap fee. Meteora adds a variable part on top that grows with the bins a swap crosses. */
export const POOL_FEE_BPS = 100;
/** The SDK's `curvature` for `seedLiquidity`: lower puts more of the tokens near the top of the range. */
export const SEED_CURVATURE = 0.6;
/** Top of the seeded range as a multiple of the starting price: default and the bounds the form accepts. */
export const DEFAULT_RANGE_MULTIPLE = 50;
export const MIN_RANGE_MULTIPLE = 10;
export const MAX_RANGE_MULTIPLE = 100;
/**
 * Slots between pool creation and the start of trading (~10 minutes). Locked positions owned by
 * the vault can only be created before the pool activates, so all of the seeding has to confirm
 * inside this window, wallet approvals included.
 */
export const ACTIVATION_DELAY_SLOTS = 1_500;
/** Compute-unit limits. Measured locally: about 420k per "initialize" transaction, 145k per deposit. */
export const SEED_INIT_COMPUTE_UNITS = 800_000;
export const SEED_DEPOSIT_COMPUTE_UNITS = 400_000;
export const CLAIM_COMPUTE_UNITS = 1_400_000;
/** Token atoms kept spare for the 1-atom ownership proof and per-transfer rounding of the tax. */
export const SEED_SLACK_ATOMS = 100n;

/** u64 max as a lock release point: the position's liquidity can never be withdrawn. */
export const LOCK_NEVER = 18_446_744_073_709_551_615n;
export const BIN_GROWTH = 1 + BIN_STEP_BPS / 10_000;
/** Bins one DLMM position covers when created by `seedLiquidity` (a constant of the DLMM program). */
export const BINS_PER_POSITION = DEFAULT_BIN_PER_POSITION.toNumber() || 70;

/** What a sale into the pool keeps of the pool price: everything but the token's transfer tax and the pool's base fee. */
export const saleRealizedBps = (transferFeeBps: number) => 10_000 - transferFeeBps - POOL_FEE_BPS;

/**
 * What has to leave a wallet for `net` tokens to arrive, with a transfer tax of `feeBps`:
 * `net x (1 + fee / (1 - fee))`, rounded up. The difference is withheld as tax.
 */
export function grossUp(net: bigint, feeBps: number): bigint {
  const keep = BigInt(10_000 - feeBps);
  return (net * 10_000n + keep - 1n) / keep;
}

/**
 * The bin a pool starts on for a price given in USDC atoms per token atom: the first bin at or
 * above it, which is also the lowest bin `seedLiquidity` deposits into for that price.
 */
export const startBinId = (pricePerAtom: string | number) => DLMM.getBinIdFromPrice(pricePerAtom, BIN_STEP_BPS, false);

export interface SeedRange {
  startBinId: number;
  /** Number of bins that receive tokens: `startBinId` up to `startBinId + binCount - 1`. */
  binCount: number;
  /** DLMM positions needed to cover them. */
  positions: number;
  /** Seeding transactions for a fresh pool: 1 ownership proof + one "initialize" and one deposit per position. */
  transactions: number;
  /** USDC per whole token at the first and the last seeded bin. */
  startPrice: number;
  topPrice: number;
  /** The same range as the `minPrice` / `maxPrice` arguments of `seedLiquidity`, placed mid-way between bins so rounding cannot shift it. */
  sdkMinPrice: number;
  sdkMaxPrice: number;
}

/** The bins a range of `multiple` times the starting price covers, starting at `start`. */
export function seedRange(start: number, multiple: number, tokenDecimals: number): SeedRange {
  const binCount = Math.max(1, Math.floor(Math.log(multiple) / Math.log(BIN_GROWTH) + 1e-9));
  const positions = Math.ceil(binCount / BINS_PER_POSITION);
  const ui = 10 ** (tokenDecimals - USDC_DECIMALS);
  const price = (binId: number) => getPriceOfBinByBinId(binId, BIN_STEP_BPS).toNumber() * ui;
  const half = Math.sqrt(BIN_GROWTH);
  return {
    startBinId: start,
    binCount,
    positions,
    transactions: 1 + 2 * positions,
    startPrice: price(start),
    topPrice: price(start + binCount - 1),
    // the SDK takes ceil(log(min)) as the first bin and floor(log(max)) - 1 as the last
    sdkMinPrice: price(start) / half,
    sdkMaxPrice: price(start + binCount) * half,
  };
}

export const validMultiple = (multiple: number) =>
  Number.isFinite(multiple) && multiple >= MIN_RANGE_MULTIPLE && multiple <= MAX_RANGE_MULTIPLE;

/* ---------- the base key of the seeded positions ---------- */

/**
 * Position addresses are derived from a throwaway "base" key that co-signs their creation. A
 * second base would create a second set of positions, so the one in use is kept for the browser
 * session, per mint, together with the range it was started with.
 */
export interface SeedSession {
  base: Keypair;
  /** Range multiple the seeding was started with; `null` until the first review. */
  multiple: number | null;
}

const seedKey = (mint: PublicKey) => `terp:seed:${mint.toBase58()}`;

export function loadSeedSession(mint: PublicKey): SeedSession | null {
  try {
    const raw = window.sessionStorage.getItem(seedKey(mint));
    if (!raw) return null;
    const stored = JSON.parse(raw) as { secret: number[]; multiple: number | null };
    return {
      base: Keypair.fromSecretKey(Uint8Array.from(stored.secret)),
      multiple: typeof stored.multiple === "number" ? stored.multiple : null,
    };
  } catch {
    return null;
  }
}

/** `false` when the browser refused to store it; the seeding then cannot survive a reload. */
export function saveSeedSession(mint: PublicKey, session: SeedSession): boolean {
  try {
    window.sessionStorage.setItem(
      seedKey(mint),
      JSON.stringify({ secret: Array.from(session.base.secretKey), multiple: session.multiple }),
    );
    return true;
  } catch {
    return false;
  }
}

/* ---------- seeding ---------- */

export interface PlannedTx {
  label: string;
  instructions: TransactionInstruction[];
  signers?: Keypair[];
  computeUnits?: number;
}

export interface SeedPlan {
  /** What is still to be sent, in order. Empty when the pool is fully seeded. */
  transactions: PlannedTx[];
  /** Transactions a fresh seeding of this range takes. */
  total: number;
  /** SOL rent of the accounts the remaining transactions create, as the SDK estimates it. */
  rentLamports: bigint;
  range: SeedRange;
}

/**
 * The transactions that seed `amount` tokens, and no USDC, into positions owned by the launch
 * vault and locked forever. Calling it again with the same base and range resumes: the SDK reads
 * the chain and leaves out positions that exist and deposits that were made.
 */
export async function buildSeedPlan(args: {
  connection: Connection;
  dlmm: DLMM;
  mint: PublicKey;
  /** The Launch PDA: owner and fee owner of the positions. */
  launch: PublicKey;
  /** The creator's wallet: pays, deposits the tokens, and becomes the positions' operator. */
  creator: PublicKey;
  base: Keypair;
  amount: bigint;
  multiple: number;
}): Promise<SeedPlan> {
  const { connection, dlmm, mint, launch, creator, base, amount, multiple } = args;
  if (!dlmm.tokenX.publicKey.equals(mint)) throw new Error("The launched token is not the pool's base token; this pool cannot be seeded here.");
  const range = seedRange(dlmm.lbPair.activeId, multiple, dlmm.tokenX.mint.decimals);
  // The SDK derives the owner's token account as if the owner were a wallet, which a PDA is not.
  // So the seeding is built for a placeholder owner and then pointed at the vault.
  const placeholder = Keypair.generate().publicKey;
  const vaultTokenAccount = tokenAta(launch, mint);
  const [seed, vaultTokens] = await Promise.all([
    dlmm.seedLiquidity(
      placeholder,
      new BN(amount.toString()),
      SEED_CURVATURE,
      range.sdkMinPrice,
      range.sdkMaxPrice,
      base.publicKey,
      creator,
      launch, // fee owner
      creator, // operator: deposits the tokens
      new BN(LOCK_NEVER.toString()),
      true,
    ),
    connection.getAccountInfo(vaultTokenAccount, "confirmed"),
  ]);
  const pairs: [PublicKey, PublicKey][] = [
    [placeholder, launch],
    [tokenAta(placeholder, mint), vaultTokenAccount],
  ];
  const retarget = (group: TransactionInstruction[] | TransactionInstruction) =>
    retargetInstructions(Array.isArray(group) ? group : [group], pairs);

  // DLMM wants the position owner to hold some of the token. The SDK looked at the placeholder's
  // account, which never exists; the vault's own account decides whether the proof is still needed.
  const proven = !!vaultTokens && unpackAccount(vaultTokenAccount, vaultTokens, TOKEN_2022_PROGRAM_ID).amount > 0n;
  const inits = seed.initializeBinArraysAndPositionIxs.map(retarget);
  const deposits = seed.addLiquidityIxs.map(retarget);
  const transactions: PlannedTx[] = [
    ...(proven || seed.sendPositionOwnerTokenProveIxs.length === 0
      ? []
      : [{ label: "Send 1 token atom to the vault (DLMM's proof that the position owner holds the token)", instructions: retarget(seed.sendPositionOwnerTokenProveIxs) }]),
    ...inits.map((instructions, index) => ({
      label: `Create locked position ${index + 1} of ${inits.length} for the vault, and its price bins`,
      instructions,
      signers: [base],
      computeUnits: SEED_INIT_COMPUTE_UNITS,
    })),
    ...deposits.map((instructions, index) => ({
      label: `Deposit tokens ${index + 1} of ${deposits.length}`,
      instructions,
      computeUnits: SEED_DEPOSIT_COMPUTE_UNITS,
    })),
  ];
  const cost = seed.costBreakdown;
  const rent = cost.totalPositionLamports
    .add(cost.totalBinArraysLamports)
    .add(cost.binArrayBitmapLamports)
    .add(vaultTokens ? new BN(0) : cost.tokenOwnerProveAssociatedTokenAccountLamports);
  return { transactions, total: range.transactions, rentLamports: BigInt(rent.toString()), range };
}

/* ---------- what the chain says about the pool's liquidity ---------- */

export interface VaultPosition {
  address: PublicKey;
  lowerBinId: number;
  upperBinId: number;
  /** Read from the decoded position account. */
  owner: PublicKey;
  operator: PublicKey;
  feeOwner: PublicKey;
  lockReleasePoint: bigint;
  /** Owner is the Launch PDA and the lock release point is u64 max. */
  locked: boolean;
  /** Launched tokens and USDC the position holds now. */
  tokens: bigint;
  usdc: bigint;
  /** Unclaimed swap fees. */
  feeUsdc: bigint;
  feeTokens: bigint;
  /** The SDK's own object, as its claim builder wants it. */
  raw: LbPosition;
}

export interface LiquidityLock {
  /**
   * `locked`: the vault owns positions with liquidity and every one of them can never be withdrawn.
   * `not-locked`: the pool holds liquidity and that is not the case.
   * `none`: nothing in the pool and no vault position holding anything.
   */
  status: "locked" | "not-locked" | "none";
  positions: VaultPosition[];
  /** Totals over the vault's positions. */
  vaultTokens: bigint;
  vaultUsdc: bigint;
  /** The pool's reserves at the same moment. */
  poolTokens: bigint;
  poolUsdc: bigint;
  unclaimedUsdc: bigint;
  unclaimedTokens: bigint;
  /** The vault positions' share of the pool's token reserve, in bps. `null` when the pool holds no tokens. */
  tokenShareBps: number | null;
  /** Every vault position pays its fees to the vault. */
  feesToVault: boolean;
}

// the SDK reports a position's totals as decimal strings
const wholeAtoms = (text: string) => (/^\d+(\.\d+)?$/.test(text) ? BigInt(text.split(".")[0]) : BigInt(Math.floor(Number(text)) || 0));
const toBig = (value: BN) => BigInt(value.toString());

/**
 * Positions of the pool owned by the launch vault, with owner, operator, fee owner and lock
 * release point decoded from each position account itself.
 */
export async function fetchLiquidityLock(connection: Connection, market: Market, launch: PublicKey): Promise<LiquidityLock> {
  const { dlmm, tokenIsX } = market;
  // the pool's reserves are read here, next to the positions, so the two are of the same moment
  const [{ userPositions }, [reserveX, reserveY]] = await Promise.all([
    dlmm.getPositionsByUserAndLbPair(launch),
    connection.getMultipleAccountsInfo([dlmm.tokenX.reserve, dlmm.tokenY.reserve], "confirmed"),
  ]);
  if (!reserveX || !reserveY) throw new Error("The pool's reserve accounts could not be read.");
  const amountX = unpackAccount(dlmm.tokenX.reserve, reserveX, dlmm.tokenX.owner).amount;
  const amountY = unpackAccount(dlmm.tokenY.reserve, reserveY, dlmm.tokenY.owner).amount;
  const poolTokens = tokenIsX ? amountX : amountY;
  const poolUsdc = tokenIsX ? amountY : amountX;
  const positions: VaultPosition[] = [];
  for (let start = 0; start < userPositions.length; start += 100) {
    const chunk = userPositions.slice(start, start + 100);
    const accounts = await connection.getMultipleAccountsInfo(chunk.map((position) => position.publicKey), "confirmed");
    chunk.forEach((position, index) => {
      const account = accounts[index];
      if (!account) throw new Error(`Position ${position.publicKey.toBase58()} could not be read.`);
      // `positionData` does not carry the operator or the lock release point; the account does
      const decoded = wrapPosition(dlmm.program, position.publicKey, account);
      const data = position.positionData;
      const owner = decoded.owner();
      const lockReleasePoint = toBig(decoded.lockReleasePoint());
      positions.push({
        address: position.publicKey,
        lowerBinId: data.lowerBinId,
        upperBinId: data.upperBinId,
        owner,
        operator: decoded.operator(),
        feeOwner: decoded.feeOwner(),
        lockReleasePoint,
        locked: owner.equals(launch) && lockReleasePoint === LOCK_NEVER,
        tokens: wholeAtoms(tokenIsX ? data.totalXAmount : data.totalYAmount),
        usdc: wholeAtoms(tokenIsX ? data.totalYAmount : data.totalXAmount),
        feeUsdc: toBig(tokenIsX ? data.feeY : data.feeX),
        feeTokens: toBig(tokenIsX ? data.feeX : data.feeY),
        raw: position,
      });
    });
  }
  positions.sort((a, b) => a.lowerBinId - b.lowerBinId);
  const sum = (pick: (position: VaultPosition) => bigint) => positions.reduce((total, position) => total + pick(position), 0n);
  const vaultTokens = sum((position) => position.tokens);
  const vaultUsdc = sum((position) => position.usdc);
  const poolEmpty = poolTokens === 0n && poolUsdc === 0n;
  const vaultHolds = vaultTokens > 0n || vaultUsdc > 0n;
  const share = poolTokens > 0n ? (vaultTokens * 10_000n) / poolTokens : null;
  return {
    status: vaultHolds && positions.every((position) => position.locked) ? "locked" : poolEmpty && !vaultHolds ? "none" : "not-locked",
    positions,
    vaultTokens,
    vaultUsdc,
    poolTokens,
    poolUsdc,
    unclaimedUsdc: sum((position) => position.feeUsdc),
    unclaimedTokens: sum((position) => position.feeTokens),
    tokenShareBps: share === null ? null : Number(share > 10_000n ? 10_000n : share),
    feesToVault: positions.every((position) => position.feeOwner.equals(launch)),
  };
}

/** USDC per whole launched token at a bin of this pool. Display only. */
export function binPrice(market: Market, binId: number): number {
  const { dlmm, tokenIsX } = market;
  const xPerY = getPriceOfBinByBinId(binId, dlmm.lbPair.binStep).toNumber() * 10 ** (dlmm.tokenX.mint.decimals - dlmm.tokenY.mint.decimals);
  return tokenIsX ? xPerY : 1 / xPerY;
}

/**
 * Transactions that claim the swap fees of the vault's positions. DLMM lets only a position's
 * operator send this and pays only the fee owner's accounts, here the vault's USDC account; the
 * builder refuses to return a claim that does not name it.
 */
export async function buildClaimFees(args: {
  dlmm: DLMM;
  positions: VaultPosition[];
  /** The wallet that sends the claim: must be the positions' operator. */
  sender: PublicKey;
  vaultUsdc: PublicKey;
}): Promise<PlannedTx[]> {
  const { dlmm, positions, sender, vaultUsdc } = args;
  const earning = positions.filter((position) => position.feeUsdc > 0n || position.feeTokens > 0n).map((position) => position.raw);
  if (earning.length === 0) throw new Error("There are no pool fees to claim.");
  const stand = Keypair.generate().publicKey;
  const claims = await dlmm.claimAllSwapFee({ owner: stand, positions: earning });
  if (claims.length === 0) throw new Error("The Meteora SDK built no claim.");
  return claims.map((transaction, index) => {
    const instructions = retargetInstructions(
      transaction.instructions.filter((ix) => ix.programId.equals(DLMM_PROGRAM_ID)),
      [[stand, sender]],
    );
    if (!instructions.some((ix) => ix.keys.some((key) => key.pubkey.equals(vaultUsdc)))) {
      throw new Error("The claim does not pay the vault's USDC account; nothing was built.");
    }
    return {
      label: `Claim pool fees into the vault${claims.length > 1 ? ` (${index + 1} of ${claims.length})` : ""}`,
      instructions,
      computeUnits: CLAIM_COMPUTE_UNITS,
    };
  });
}
