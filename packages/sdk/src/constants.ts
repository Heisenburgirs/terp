import { PublicKey } from "@solana/web3.js";
import idl from "./idl/terp.json";

export const TERP_PROGRAM_ID = new PublicKey(idl.address);

/** Phoenix perpetuals ("Eternal"). Not the Phoenix v1 spot order book. */
export const PHOENIX_PROGRAM_ID = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
export const PHOENIX_LOG_AUTHORITY = new PublicKey("GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS");
export const PHOENIX_GLOBAL_CONFIG = new PublicKey("2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ");
export const HAWKEYE_PROGRAM_ID = new PublicKey("RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj");
export const EMBER_PROGRAM_ID = new PublicKey("EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy");
export const EMBER_STATE = new PublicKey("6ur7v6AXNpnHeEb6xuk7PyezvZ1i5GrgYyWZkNCpzbRz");
export const EMBER_VAULT = new PublicKey("FKcEb4TdPDTRuMnQDpSEPQBcrm15S73xiUD6Qf8ZLUkq");
export const PHOENIX_API_URL = "https://perp-api.phoenix.trade";

/** Phoenix SOL perp on mainnet (asset 0), from `GET /exchange/markets`. */
export const SOL_MARKET = {
  symbol: "SOL",
  assetId: 0,
  orderbook: new PublicKey("71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2"),
  spline: new PublicKey("EVhkquLbfm5rDRXtZu9FoyDSXX5mYq2EYU6yD8zfKEqM"),
  /** One base lot is 0.01 SOL. */
  baseLotDecimals: 2,
  /** Quote lots (USDC atoms) per base lot, per tick. */
  tickSize: 100,
} as const;

/** Meteora DLMM, the pool that supports Token-2022 transfer-fee mints permissionlessly. */
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS = 6;

// Protocol policy, fixed in the program and copied into each launch.
/** Transfer-tax tiers a launch can choose from; fixed on the mint for good. */
export const TRANSFER_FEE_TIERS = [100, 300] as const;
export const REDEMPTION_FEE_BPS = 300;
/** The leverage the vault aims to keep, and the ceiling after any buy. */
export const TARGET_LEVERAGE_BPS = 50_000;
/** Under this a deployment buys exposure back up to target. */
export const MIN_LEVERAGE_BPS = 47_500;
/** Above this anyone may reduce the position. */
export const MAX_LEVERAGE_BPS = 60_000;
/** What a deleverage reduces leverage to. */
export const DELEVERAGE_TO_BPS = 55_000;
/** Highest share of converted tax the platform may take as its keeper fee. */
export const MAX_KEEPER_FEE_BPS = 2_000;
export const EXIT_COST_BPS = 5;
export const ORDER_SLIPPAGE_BPS = 50;
/** Solana slots are roughly 0.4s. */
export const SLOT_MS = 400;
