import { AnchorProvider, Program, type Idl } from "@anchor-lang/core";
import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getMint,
  getTransferFeeAmount,
  unpackAccount,
} from "@solana/spl-token";
import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  EMBER_PROGRAM_ID,
  EMBER_STATE,
  EMBER_VAULT,
  HAWKEYE_PROGRAM_ID,
  PHOENIX_GLOBAL_CONFIG,
  PHOENIX_LOG_AUTHORITY,
  PHOENIX_PROGRAM_ID,
  USDC_MINT,
} from "./constants";
import idl from "./idl/terp.json";
import { quoteRedemption, redemptionValuePerToken, vaultEquity, type RedemptionQuote } from "./math";
import { claimPda, configPda, launchAddresses, launchPda, marketPda, splAta, tokenAta, usdcAta } from "./pdas";
import {
  EMPTY_PERP_VIEW,
  fetchExchange,
  fetchPerpView,
  fetchTraderHeader,
  type Exchange,
  type PerpView,
  type TraderHeader,
} from "./phoenix";

const big = (v: { toString(): string } | number | bigint) => BigInt(v.toString());
const bn = (v: bigint | number) => new BN(v.toString());

export interface ProtocolConfig {
  admin: PublicKey;
  /** The platform's wallet: receives the platform fee and residual USDC of finished launches. */
  treasury: PublicKey;
  /** The platform's share of each tax sale, paid to the treasury, for launches created from now on. */
  platformFeeBps: number;
  swapProgram: PublicKey;
  paused: boolean;
}

/** A Phoenix perp market launches can choose as their leveraged asset. */
export interface Market {
  address: PublicKey;
  assetId: number;
  symbol: string;
  orderbook: PublicKey;
  spline: PublicKey;
  /** Quote lots (USDC atoms) per base lot, per price tick. */
  tickSize: bigint;
  /** One base lot is `10^-baseLotDecimals` of the asset. */
  baseLotDecimals: number;
}

export interface Launch {
  address: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  pool: PublicKey | null;
  vaultUsdc: PublicKey;
  taxAccount: PublicKey;
  taxUsdc: PublicKey;
  traderAccount: PublicKey | null;
  canonicalAccount: PublicKey | null;
  orderbook: PublicKey;
  spline: PublicKey;
  assetId: number;
  tickSize: bigint;
  baseLotDecimals: number;
  /** Ticker of the leveraged asset, e.g. "SOL". */
  symbol: string;
  direction: "long" | "short";
  decimals: number;
  /** The token's transfer tax: 100 (1%) or 300 (3%), fixed on the mint. */
  transferFeeBps: number;
  /** The leverage the vault aims to keep (5x): the ceiling whenever exposure is added. */
  targetLeverageBps: number;
  /** Under this (4.75x) `rebalance` or `deploy` buys exposure back up to target. */
  minLeverageBps: number;
  /** Above this (6x) `rebalance` or `deleverage` cuts the position. */
  maxLeverageBps: number;
  /** What a cut reduces leverage to (5.5x). */
  deleverageToBps: number;
  /** The platform's share of the USDC from each tax sale (3%); fixed at creation. */
  platformFeeBps: number;
  redemptionFeeBps: number;
  exitCostBps: number;
  orderSlippageBps: number;
  maxPriceDropBps: number;
  maxMarkStalenessSlots: bigint;
  minConvertTokens: bigint;
  maxConvertTokens: bigint;
  convertCooldownSlots: bigint;
  minDepositUsdc: bigint;
  minRedeemTokens: bigint;
  initialSupply: bigint;
  creatorAllocation: bigint;
  poolAllocation: bigint;
  /** Reference price for tax conversions, USDC atoms per token atom x 1e12. */
  emaPrice: bigint;
  lastConvertSlot: bigint;
  /** USDC owed to redeemers whose Phoenix withdrawal was queued. Senior to equity. */
  pendingClaims: bigint;
  tokensCollected: bigint;
  tokensConverted: bigint;
  /** Converted tax that reached the vault: pool proceeds less the platform fee. */
  usdcConverted: bigint;
  /** Platform fees paid to the platform treasury out of this launch's converted tax. */
  platformFeesPaid: bigint;
  /** Slot of the last deposit or top-up, by `rebalance` or `deploy`; `0n` if there was none. */
  lastRebalanceSlot: bigint;
  usdcDeposited: bigint;
  usdcWithdrawn: bigint;
  tokensRedeemed: bigint;
  usdcRedeemed: bigint;
  redemptionFeesRetained: bigint;
  exitCostsRetained: bigint;
  createdSlot: bigint;
}

export interface Claim {
  address: PublicKey;
  launch: PublicKey;
  owner: PublicKey;
  amount: bigint;
}

export type RiskStatus = "no-position" | "healthy" | "above-target" | "deleverage" | "liquidatable";

/** Everything the UI and a bot need to know about one vault, read at one point in time. */
export interface VaultState {
  launch: Launch;
  slot: bigint;
  /** `S`: the mint's current supply, including pool, creator and withheld balances. */
  supply: bigint;
  idleUsdc: bigint;
  /** Idle USDC not reserved for claims: what redemptions and deployment can use. */
  freeUsdc: bigint;
  canonical: bigint;
  /** Tax tokens collected and waiting to be sold. Not part of `E` until converted. */
  taxTokens: bigint;
  /** Fees still withheld on the mint itself. */
  withheldOnMint: bigint;
  trader: TraderHeader | null;
  perp: PerpView;
  /** `E`: assets less outstanding claims. */
  equity: bigint;
  /** `E / S` for one whole token, in USDC atoms, before redemption fees. */
  redemptionValuePerToken: bigint;
  /** Leverage of the Phoenix account, in bps. `null` when it has no equity left. */
  leverageBps: bigint | null;
  risk: RiskStatus;
  markIsStale: boolean;
}

/**
 * What any wallet can trigger on a vault right now, and why not if it cannot. No caller is
 * privileged: the program fixes every amount, price and destination, so whoever sends these
 * only picks the moment and receives nothing.
 */
export interface PendingWork {
  /** Tax tokens the next `convert_tax` has to sell; `0n` if nothing can be converted now. */
  convertBatch: bigint;
  convertBlockedBy: "no-pool" | "below-threshold" | "cooldown" | null;
  /** USDC the next `rebalance` or `deploy` would deposit; `0n` if below the launch's minimum. */
  deployUsdc: bigint;
  /**
   * Whether that deploy would also add exposure: there is no position, or leverage after the
   * deposit is under the launch minimum, so it is topped up to target. Otherwise a deploy only
   * adds margin.
   */
  wouldIncrease: boolean;
  /** Whether `deploy` has something to do: a deposit, or a top-up. It fails otherwise. */
  canDeploy: boolean;
  /** Leverage is above the launch maximum, so the position can be cut. */
  canDeleverage: boolean;
  /**
   * Whether `rebalance` would do something now: deposit, top up, or cut. `rebalance` succeeds
   * either way; this only says whether it is worth attaching.
   */
  canRebalance: boolean;
  /** Claims not covered by idle USDC and not already requested from Phoenix. */
  claimsShortfall: bigint;
  canonicalToUnwrap: bigint;
}

export interface CreateLaunchParams {
  /** Asset id of the listed market whose perp the tax is levered into. */
  assetId: number;
  totalSupply: bigint;
  creatorAllocation: bigint;
  poolAllocation: bigint;
  /**
   * What a sale into the pool realizes at launch, USDC atoms per token atom x 1e12: the pool's
   * starting price less the 3% transfer fee and the pool's swap fee. Tax conversions are
   * refused below this by more than `maxPriceDropBps` per cooldown elapsed.
   */
  initialPrice: bigint;
  minConvertTokens: bigint;
  maxConvertTokens: bigint;
  convertCooldownSlots: bigint;
  maxPriceDropBps: number;
  minDepositUsdc: bigint;
  minRedeemTokens: bigint;
}

const readOnlyWallet = {
  publicKey: Keypair.generate().publicKey,
  signTransaction: async () => {
    throw new Error("read-only client");
  },
  signAllTransactions: async () => {
    throw new Error("read-only client");
  },
};

const symbolOf = (bytes: number[]) => Buffer.from(bytes).toString("ascii").replace(/\0+$/, "");

const orNull = (key: PublicKey) => (key.equals(PublicKey.default) ? null : key);

type AccountClient = {
  fetchNullable(a: PublicKey): Promise<any>;
  all(filters?: unknown[]): Promise<{ publicKey: PublicKey; account: any }[]>;
};

/**
 * Builds instructions and reads state. It never signs or sends: callers decide when a
 * transaction goes out and who pays for it. The admin and the creator have their own few
 * instructions; everything else, including selling tax and adjusting the position, can be sent
 * by any wallet.
 */
export class TerpClient {
  readonly program: Program;
  readonly programId: PublicKey;
  private exchange: Exchange | null = null;

  constructor(
    readonly connection: Connection,
    programId?: PublicKey,
  ) {
    const provider = new AnchorProvider(connection, readOnlyWallet as never, { commitment: "confirmed" });
    const resolved = programId ? { ...idl, address: programId.toBase58() } : idl;
    this.program = new Program(resolved as Idl, provider);
    this.programId = this.program.programId;
  }

  private get accounts(): Record<string, AccountClient> {
    return this.program.account as never;
  }

  private get methods(): Record<string, (...args: unknown[]) => any> {
    return this.program.methods as never;
  }

  // Reads

  async getExchange(): Promise<Exchange> {
    this.exchange ??= await fetchExchange(this.connection);
    return this.exchange;
  }

  async fetchConfig(): Promise<ProtocolConfig | null> {
    const raw = await this.accounts.protocolConfig.fetchNullable(configPda(this.programId));
    if (!raw) return null;
    return {
      admin: raw.admin,
      treasury: raw.treasury,
      platformFeeBps: raw.platformFeeBps,
      swapProgram: raw.swapProgram,
      paused: raw.paused,
    };
  }

  /** Leveraged assets the admin has listed, by asset id. */
  async fetchMarkets(): Promise<Market[]> {
    const all = await this.accounts.market.all();
    return all
      .map(({ publicKey, account }) => ({
        address: publicKey,
        assetId: account.assetId as number,
        symbol: symbolOf(account.symbol),
        orderbook: account.orderbook as PublicKey,
        spline: account.spline as PublicKey,
        tickSize: big(account.tickSize),
        baseLotDecimals: account.baseLotDecimals as number,
      }))
      .sort((a, b) => a.assetId - b.assetId);
  }

  private toLaunch(address: PublicKey, raw: any): Launch {
    return {
      address,
      mint: raw.mint,
      creator: raw.creator,
      pool: orNull(raw.pool),
      vaultUsdc: raw.vaultUsdc,
      taxAccount: raw.taxAccount,
      taxUsdc: raw.taxUsdc,
      traderAccount: orNull(raw.traderAccount),
      canonicalAccount: orNull(raw.canonicalAccount),
      orderbook: raw.orderbook,
      spline: raw.spline,
      assetId: raw.assetId,
      tickSize: big(raw.tickSize),
      baseLotDecimals: raw.baseLotDecimals,
      symbol: symbolOf(raw.symbol),
      direction: raw.direction.long ? "long" : "short",
      decimals: raw.decimals,
      transferFeeBps: raw.transferFeeBps,
      targetLeverageBps: raw.targetLeverageBps,
      minLeverageBps: raw.minLeverageBps,
      maxLeverageBps: raw.maxLeverageBps,
      deleverageToBps: raw.deleverageToBps,
      platformFeeBps: raw.platformFeeBps,
      redemptionFeeBps: raw.redemptionFeeBps,
      exitCostBps: raw.exitCostBps,
      orderSlippageBps: raw.orderSlippageBps,
      maxPriceDropBps: raw.maxPriceDropBps,
      maxMarkStalenessSlots: big(raw.maxMarkStalenessSlots),
      minConvertTokens: big(raw.minConvertTokens),
      maxConvertTokens: big(raw.maxConvertTokens),
      convertCooldownSlots: big(raw.convertCooldownSlots),
      minDepositUsdc: big(raw.minDepositUsdc),
      minRedeemTokens: big(raw.minRedeemTokens),
      initialSupply: big(raw.initialSupply),
      creatorAllocation: big(raw.creatorAllocation),
      poolAllocation: big(raw.poolAllocation),
      emaPrice: big(raw.emaPrice),
      lastConvertSlot: big(raw.lastConvertSlot),
      pendingClaims: big(raw.pendingClaims),
      tokensCollected: big(raw.tokensCollected),
      tokensConverted: big(raw.tokensConverted),
      usdcConverted: big(raw.usdcConverted),
      platformFeesPaid: big(raw.platformFeesPaid),
      lastRebalanceSlot: big(raw.lastRebalanceSlot),
      usdcDeposited: big(raw.usdcDeposited),
      usdcWithdrawn: big(raw.usdcWithdrawn),
      tokensRedeemed: big(raw.tokensRedeemed),
      usdcRedeemed: big(raw.usdcRedeemed),
      redemptionFeesRetained: big(raw.redemptionFeesRetained),
      exitCostsRetained: big(raw.exitCostsRetained),
      createdSlot: big(raw.createdSlot),
    };
  }

  async fetchLaunch(mint: PublicKey): Promise<Launch | null> {
    const address = launchPda(mint, this.programId);
    const raw = await this.accounts.launch.fetchNullable(address);
    return raw ? this.toLaunch(address, raw) : null;
  }

  async fetchAllLaunches(): Promise<Launch[]> {
    const all = await this.accounts.launch.all();
    return all
      .map(({ publicKey, account }) => this.toLaunch(publicKey, account))
      .sort((a, b) => Number(b.createdSlot - a.createdSlot));
  }

  private toClaim(address: PublicKey, raw: any): Claim {
    return { address, launch: raw.launch, owner: raw.owner, amount: big(raw.amount) };
  }

  /** What `owner` is still owed after a redemption whose Phoenix withdrawal was queued. */
  async fetchClaim(launch: PublicKey, owner: PublicKey): Promise<Claim | null> {
    const address = claimPda(launch, owner, this.programId);
    const raw = await this.accounts.claim.fetchNullable(address);
    return raw ? this.toClaim(address, raw) : null;
  }

  /** Unpaid claims of one launch, largest first. */
  async fetchClaims(launch: PublicKey): Promise<Claim[]> {
    const all = await this.accounts.claim.all([{ memcmp: { offset: 8, bytes: launch.toBase58() } }]);
    return all
      .map(({ publicKey, account }) => this.toClaim(publicKey, account))
      .filter((claim) => claim.amount > 0n)
      .sort((a, b) => (b.amount > a.amount ? 1 : -1));
  }

  /**
   * One consistent snapshot of a vault. `simulationPayer` is any existing funded account, used
   * only to simulate Phoenix's read-only views.
   */
  async fetchVaultState(launch: Launch, simulationPayer: PublicKey): Promise<VaultState> {
    const { connection } = this;
    const [slot, mint, infos] = await Promise.all([
      connection.getSlot("confirmed"),
      getMint(connection, launch.mint, "confirmed", TOKEN_2022_PROGRAM_ID),
      connection.getMultipleAccountsInfo(
        [launch.vaultUsdc, launch.taxAccount, launch.canonicalAccount ?? launch.vaultUsdc],
        "confirmed",
      ),
    ]);
    const amount = (i: number, key: PublicKey, program: PublicKey) =>
      infos[i] ? unpackAccount(key, infos[i], program).amount : 0n;
    const idleUsdc = amount(0, launch.vaultUsdc, TOKEN_PROGRAM_ID);
    const taxTokens = amount(1, launch.taxAccount, TOKEN_2022_PROGRAM_ID);
    const canonical = launch.canonicalAccount ? amount(2, launch.canonicalAccount, TOKEN_PROGRAM_ID) : 0n;

    let trader: TraderHeader | null = null;
    let perp = EMPTY_PERP_VIEW;
    if (launch.traderAccount) {
      trader = await fetchTraderHeader(connection, launch.traderAccount);
      if (trader) {
        perp = await fetchPerpView(
          connection,
          await this.getExchange(),
          launch,
          launch.traderAccount,
          simulationPayer,
        );
      }
    }

    const assets = vaultEquity(idleUsdc, canonical, perp.equity);
    const equity = assets > launch.pendingClaims ? assets - launch.pendingClaims : 0n;
    const leverage = perp.leverageBps;
    let risk: RiskStatus = "healthy";
    if (perp.notional === 0n) risk = "no-position";
    else if (perp.isLiquidatable || leverage === null) risk = "liquidatable";
    else if (leverage > BigInt(launch.maxLeverageBps)) risk = "deleverage";
    else if (leverage > BigInt(launch.targetLeverageBps)) risk = "above-target";

    return {
      launch,
      slot: BigInt(slot),
      supply: mint.supply,
      idleUsdc,
      freeUsdc: idleUsdc > launch.pendingClaims ? idleUsdc - launch.pendingClaims : 0n,
      canonical,
      taxTokens,
      withheldOnMint: mintWithheld(mint),
      trader,
      perp,
      equity,
      redemptionValuePerToken: redemptionValuePerToken(equity, mint.supply, launch.decimals),
      leverageBps: leverage,
      risk,
      markIsStale:
        perp.notional > 0n && BigInt(slot) - perp.markPriceSlot > launch.maxMarkStalenessSlots,
    };
  }

  /**
   * What redeeming `amount` would pay right now. The exit cost shown is the program's minimum;
   * if closing the redeemer's share of the position costs more than that (slippage), the
   * program charges the actual cost, so set the minimum payout a little below this quote.
   */
  previewRedemption(state: VaultState, amount: bigint): RedemptionQuote {
    return quoteRedemption(
      amount,
      state.supply,
      state.equity,
      state.perp.notional,
      state.launch.redemptionFeeBps,
      state.launch.exitCostBps,
    );
  }

  /**
   * Mirrors the program's own conditions for the upkeep instructions, all of which are open to
   * any wallet. `paused` is the protocol config's pause flag.
   */
  pendingWork(state: VaultState, paused = false): PendingWork {
    const { launch, perp } = state;
    let convertBatch = 0n;
    let convertBlockedBy: PendingWork["convertBlockedBy"] = null;
    if (!launch.pool) convertBlockedBy = "no-pool";
    else if (state.taxTokens < launch.minConvertTokens) convertBlockedBy = "below-threshold";
    else if (launch.tokensConverted > 0n && state.slot - launch.lastConvertSlot < launch.convertCooldownSlots)
      convertBlockedBy = "cooldown";
    else convertBatch = state.taxTokens < launch.maxConvertTokens ? state.taxTokens : launch.maxConvertTokens;
    if (paused) convertBatch = 0n;

    const onboarded = Boolean(state.trader?.isOnboarded);
    const deployUsdc = onboarded && !paused && state.freeUsdc >= launch.minDepositUsdc ? state.freeUsdc : 0n;
    // after the deposit, exposure is added only under the minimum leverage (or with no position)
    const equityAfter = perp.equity + deployUsdc;
    const underMinimum =
      perp.notional === 0n ||
      (equityAfter > 0n && (perp.notional * 10_000n) / equityAfter < BigInt(launch.minLeverageBps));
    const lotValue = perp.markPriceTicks * launch.tickSize;
    const aim = equityAfter > 0n ? (equityAfter * BigInt(launch.targetLeverageBps) * 98n) / 1_000_000n : 0n;
    const wouldIncrease =
      onboarded &&
      !paused &&
      !perp.isLiquidatable &&
      underMinimum &&
      lotValue > 0n &&
      aim > perp.notional &&
      aim - perp.notional >= lotValue;

    const shortfall = launch.pendingClaims > state.idleUsdc + state.canonical ? launch.pendingClaims - state.idleUsdc - state.canonical : 0n;
    const canDeploy = (deployUsdc > 0n && !perp.isLiquidatable) || wouldIncrease;
    const canDeleverage = state.risk === "deleverage" || (state.risk === "liquidatable" && perp.notional > 0n);
    return {
      convertBatch,
      convertBlockedBy,
      deployUsdc,
      wouldIncrease,
      canDeploy,
      canDeleverage,
      canRebalance: canDeploy || canDeleverage,
      claimsShortfall: state.trader?.hasQueuedWithdrawal ? 0n : shortfall,
      canonicalToUnwrap: state.canonical,
    };
  }

  /** Token accounts of a mint that currently hold withheld transfer tax, largest first. */
  async findWithheld(mint: PublicKey, limit = 20): Promise<{ account: PublicKey; amount: bigint }[]> {
    const accounts = await this.connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    });
    const withheld: { account: PublicKey; amount: bigint }[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        const fee = getTransferFeeAmount(unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID));
        if (fee && fee.withheldAmount > 0n) withheld.push({ account: pubkey, amount: fee.withheldAmount });
      } catch {
        // not a token account of this mint
      }
    }
    return withheld.sort((a, b) => (b.amount > a.amount ? 1 : -1)).slice(0, limit);
  }

  /** The addresses from `findWithheld`, for `collectTaxIx`. */
  async findWithheldAccounts(mint: PublicKey, limit = 20): Promise<PublicKey[]> {
    return (await this.findWithheld(mint, limit)).map((w) => w.account);
  }

  // Admin and creator instructions

  initConfigIx(
    admin: PublicKey,
    args: {
      treasury: PublicKey;
      platformFeeBps: number;
      swapProgram: PublicKey;
      swapDiscriminators: number[][];
    },
  ): Promise<TransactionInstruction> {
    return this.methods
      .initConfig(args)
      .accountsStrict({
        admin,
        config: configPda(this.programId),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** Admin only. Omitted fields stay as they are. */
  updateConfigIx(
    admin: PublicKey,
    args: { admin?: PublicKey; treasury?: PublicKey; platformFeeBps?: number; paused?: boolean },
  ): Promise<TransactionInstruction> {
    return this.methods
      .updateConfig({
        admin: args.admin ?? null,
        treasury: args.treasury ?? null,
        platformFeeBps: args.platformFeeBps ?? null,
        paused: args.paused ?? null,
      })
      .accountsStrict({ admin, config: configPda(this.programId) })
      .instruction();
  }

  /** Admin only. Lists a Phoenix perp market as a leveraged asset; a listing is permanent. */
  addMarketIx(
    admin: PublicKey,
    market: { assetId: number; symbol: string; orderbook: PublicKey; spline: PublicKey; tickSize: bigint; baseLotDecimals: number },
  ): Promise<TransactionInstruction> {
    const symbol = Buffer.alloc(16);
    symbol.write(market.symbol.slice(0, 16), "ascii");
    return this.methods
      .addMarket({
        assetId: market.assetId,
        tickSize: bn(market.tickSize),
        baseLotDecimals: market.baseLotDecimals,
        symbol: [...symbol],
      })
      .accountsStrict({
        admin,
        config: configPda(this.programId),
        market: marketPda(market.assetId, this.programId),
        orderbook: market.orderbook,
        spline: market.spline,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `params.assetId` picks the leveraged asset from the listed markets, for good. */
  createLaunchIx(creator: PublicKey, mint: PublicKey, params: CreateLaunchParams): Promise<TransactionInstruction> {
    const a = launchAddresses(mint, this.programId);
    return this.methods
      .createLaunch({
        totalSupply: bn(params.totalSupply),
        creatorAllocation: bn(params.creatorAllocation),
        poolAllocation: bn(params.poolAllocation),
        initialPrice: bn(params.initialPrice),
        minConvertTokens: bn(params.minConvertTokens),
        maxConvertTokens: bn(params.maxConvertTokens),
        convertCooldownSlots: bn(params.convertCooldownSlots),
        maxPriceDropBps: params.maxPriceDropBps,
        minDepositUsdc: bn(params.minDepositUsdc),
        minRedeemTokens: bn(params.minRedeemTokens),
      })
      .accountsStrict({
        creator,
        config: configPda(this.programId),
        market: marketPda(params.assetId, this.programId),
        mint,
        launch: a.launch,
        taxAuthority: a.taxAuthority,
        taxAccount: a.taxAccount,
        usdcMint: USDC_MINT,
        vaultUsdc: a.vaultUsdc,
        taxUsdc: a.taxUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  setPoolIx(creator: PublicKey, mint: PublicKey, pool: PublicKey): Promise<TransactionInstruction> {
    return this.methods
      .setPool()
      .accountsStrict({
        creator,
        config: configPda(this.programId),
        launch: launchPda(mint, this.programId),
        pool,
      })
      .instruction();
  }

  // Vault instructions. All of them are open to any wallet: the program fixes amounts, prices
  // and destinations, so the caller only supplies the moment and receives nothing.

  async registerTraderIx(payer: PublicKey, mint: PublicKey): Promise<TransactionInstruction> {
    const a = launchAddresses(mint, this.programId);
    const exchange = await this.getExchange();
    return this.methods
      .registerTrader()
      .accountsStrict({
        payer,
        launch: a.launch,
        phoenixProgram: PHOENIX_PROGRAM_ID,
        logAuthority: PHOENIX_LOG_AUTHORITY,
        globalConfig: PHOENIX_GLOBAL_CONFIG,
        traderAccount: a.traderAccount,
        canonicalMint: exchange.canonicalMint,
        canonicalAccount: splAta(a.launch, exchange.canonicalMint),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `sources` are token accounts holding withheld fees. */
  collectTaxIx(payer: PublicKey, launch: Launch, sources: PublicKey[]): Promise<TransactionInstruction> {
    return this.methods
      .collectTax()
      .accountsStrict({
        payer,
        launch: launch.address,
        mint: launch.mint,
        taxAccount: launch.taxAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(sources.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
      .instruction();
  }

  /**
   * Open to any wallet. Sells one tax batch. `swap` is the AMM's own swap instruction for exactly
   * `tokensIn`, built with `user` = the launch's tax authority; the program signs for that PDA,
   * enforces the batch size, the cooldown and the price floor itself, pays the launch's platform fee to the
   * platform `treasury` (the one in the config; its USDC account must exist) and forwards the
   * rest of the USDC to the vault.
   */
  convertTaxIx(
    caller: PublicKey,
    launch: Launch,
    tokensIn: bigint,
    swap: TransactionInstruction,
    treasury: PublicKey,
  ): Promise<TransactionInstruction> {
    const taxAuthority = launchAddresses(launch.mint, this.programId).taxAuthority;
    const remaining: AccountMeta[] = swap.keys.map((k) => ({
      pubkey: k.pubkey,
      isWritable: k.isWritable,
      // a PDA cannot sign the outer transaction; the program signs for it in the CPI
      isSigner: k.isSigner && !k.pubkey.equals(taxAuthority),
    }));
    return this.methods
      .convertTax(bn(tokensIn), Buffer.from(swap.data))
      .accountsStrict({
        caller,
        config: configPda(this.programId),
        launch: launch.address,
        taxAuthority,
        taxAccount: launch.taxAccount,
        taxUsdc: launch.taxUsdc,
        vaultUsdc: launch.vaultUsdc,
        treasuryUsdc: usdcAta(treasury),
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        swapProgram: swap.programId,
      })
      .remainingAccounts(remaining)
      .instruction();
  }

  private async venue(launch: Launch) {
    const exchange = await this.getExchange();
    const addresses = launchAddresses(launch.mint, this.programId);
    return {
      phoenix: {
        phoenixProgram: PHOENIX_PROGRAM_ID,
        logAuthority: PHOENIX_LOG_AUTHORITY,
        globalConfig: PHOENIX_GLOBAL_CONFIG,
        traderAccount: launch.traderAccount ?? addresses.traderAccount,
        perpAssetMap: exchange.perpAssetMap,
        orderbook: launch.orderbook,
        spline: launch.spline,
        globalVault: exchange.globalVault,
        withdrawQueue: exchange.withdrawQueue,
        hawkeyeProgram: HAWKEYE_PROGRAM_ID,
      },
      ember: {
        emberProgram: EMBER_PROGRAM_ID,
        emberState: EMBER_STATE,
        emberVault: EMBER_VAULT,
        usdcMint: USDC_MINT,
        canonicalMint: exchange.canonicalMint,
        vaultUsdc: launch.vaultUsdc,
        canonicalAccount: launch.canonicalAccount ?? splAta(launch.address, exchange.canonicalMint),
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      tail: exchange.tail.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    };
  }

  /**
   * Open to any wallet. Deposits the vault's idle USDC as collateral, and tops exposure up to
   * target if there is no position or leverage is under the launch minimum. The program sizes
   * and prices everything. Fails when there is nothing to do; use `rebalanceIx` for a step that
   * must not fail the transaction it shares.
   */
  async deployIx(caller: PublicKey, launch: Launch): Promise<TransactionInstruction> {
    const { phoenix, ember, tail } = await this.venue(launch);
    return this.methods
      .deploy()
      .accountsStrict({ caller, config: configPda(this.programId), launch: launch.address, phoenix, ember })
      .remainingAccounts(tail)
      .instruction();
  }

  /**
   * Open to any wallet. Does whatever the position needs right now: cuts it to 5.5x if leverage
   * is above the launch maximum; otherwise, unless the protocol is paused, deposits idle USDC
   * and tops exposure up to target when leverage is under the launch minimum or there is no
   * position. When there is nothing safe to do (nothing idle, in band, stale price, account
   * about to be liquidated, trader account not yet enabled, paused) it succeeds doing nothing,
   * so it can ride along in another transaction, such as a trade, without failing it for lack
   * of work. Can follow `collectTaxIx` and `convertTaxIx` in the same transaction.
   */
  async rebalanceIx(caller: PublicKey, launch: Launch): Promise<TransactionInstruction> {
    const { phoenix, ember, tail } = await this.venue(launch);
    return this.methods
      .rebalance()
      .accountsStrict({ caller, config: configPda(this.programId), launch: launch.address, phoenix, ember })
      .remainingAccounts(tail)
      .instruction();
  }

  /** Fails unless leverage is above the launch maximum; cuts the position to 5.5x. */
  async deleverageIx(caller: PublicKey, launch: Launch): Promise<TransactionInstruction> {
    const { phoenix, ember, tail } = await this.venue(launch);
    return this.methods
      .deleverage()
      .accountsStrict({ caller, launch: launch.address, phoenix, ember })
      .remainingAccounts(tail)
      .instruction();
  }

  /** Re-requests from Phoenix what claims are still short of. */
  async fundClaimsIx(caller: PublicKey, launch: Launch): Promise<TransactionInstruction> {
    const { phoenix, ember, tail } = await this.venue(launch);
    return this.methods
      .fundClaims()
      .accountsStrict({ caller, launch: launch.address, phoenix, ember })
      .remainingAccounts(tail)
      .instruction();
  }

  async unwrapCanonicalIx(caller: PublicKey, launch: Launch): Promise<TransactionInstruction> {
    const { ember } = await this.venue(launch);
    return this.methods
      .unwrapCanonical()
      .accountsStrict({ caller, launch: launch.address, ember })
      .instruction();
  }

  /**
   * The holder's one-transaction redemption: burns `amount` and pays USDC, closing the holder's
   * share of the position and withdrawing collateral if the vault's idle USDC does not cover it.
   * No tokens are transferred, so no transfer fee applies. The first instruction creates the
   * holder's USDC account if needed. The transaction needs a raised compute budget and, on
   * mainnet, an address lookup table to fit.
   */
  async redeemIxs(owner: PublicKey, launch: Launch, amount: bigint, minPayout: bigint): Promise<TransactionInstruction[]> {
    const { phoenix, ember, tail } = await this.venue(launch);
    const ownerUsdc = usdcAta(owner);
    const redeem = await this.methods
      .redeem(bn(amount), bn(minPayout))
      .accountsStrict({
        owner,
        launch: launch.address,
        mint: launch.mint,
        tokenAccount: tokenAta(owner, launch.mint),
        ownerUsdc,
        claim: claimPda(launch.address, owner, this.programId),
        phoenix,
        ember,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(tail)
      .instruction();
    return [
      createAssociatedTokenAccountIdempotentInstruction(owner, ownerUsdc, owner, USDC_MINT, TOKEN_PROGRAM_ID),
      redeem,
    ];
  }

  /** Pays `owner`'s claim from the vault's idle USDC. The money can only go to `owner`. */
  async payClaimIxs(caller: PublicKey, launch: Launch, owner: PublicKey): Promise<TransactionInstruction[]> {
    const ownerUsdc = usdcAta(owner);
    const pay = await this.methods
      .payClaim()
      .accountsStrict({
        caller,
        launch: launch.address,
        owner,
        claim: claimPda(launch.address, owner, this.programId),
        ownerUsdc,
        vaultUsdc: launch.vaultUsdc,
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return [
      createAssociatedTokenAccountIdempotentInstruction(caller, ownerUsdc, owner, USDC_MINT, TOKEN_PROGRAM_ID),
      pay,
    ];
  }

  async sweepResidualIx(caller: PublicKey, launch: Launch, treasury: PublicKey): Promise<TransactionInstruction> {
    return this.methods
      .sweepResidual()
      .accountsStrict({
        caller,
        config: configPda(this.programId),
        launch: launch.address,
        mint: launch.mint,
        vaultUsdc: launch.vaultUsdc,
        treasuryUsdc: usdcAta(treasury),
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  /**
   * Accounts that appear in every Phoenix-touching transaction of this protocol. Put them in an
   * address lookup table so redemptions and deployments fit in one transaction.
   */
  async lookupTableAddresses(): Promise<PublicKey[]> {
    const exchange = await this.getExchange();
    const markets = await this.fetchMarkets();
    return [
      this.programId,
      configPda(this.programId),
      PHOENIX_PROGRAM_ID,
      PHOENIX_LOG_AUTHORITY,
      PHOENIX_GLOBAL_CONFIG,
      HAWKEYE_PROGRAM_ID,
      EMBER_PROGRAM_ID,
      EMBER_STATE,
      EMBER_VAULT,
      USDC_MINT,
      exchange.canonicalMint,
      exchange.globalVault,
      exchange.perpAssetMap,
      exchange.withdrawQueue,
      ...exchange.tail,
      ...markets.flatMap((market) => [market.orderbook, market.spline]),
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId,
    ];
  }
}

function mintWithheld(mint: Awaited<ReturnType<typeof getMint>>): bigint {
  // TransferFeeConfig TLV: type u16, length u16, two authorities, then withheld_amount u64
  const tlv = mint.tlvData;
  let at = 0;
  while (at + 4 <= tlv.length) {
    const type = tlv.readUInt16LE(at);
    const length = tlv.readUInt16LE(at + 2);
    if (type === 1 && length >= 72) return tlv.readBigUInt64LE(at + 4 + 64);
    if (type === 0) break;
    at += 4 + length;
  }
  return 0n;
}
