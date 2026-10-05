"use client";

import DLMM, {
  ActivationType,
  CollectFeeMode,
  deriveCustomizablePermissionlessLbPair,
  getPriceOfBinByBinId,
} from "@meteora-ag/dlmm";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  DLMM_PROGRAM_ID,
  MAX_KEEPER_FEE_BPS,
  SLOT_MS,
  TRANSFER_FEE_TIERS,
  USDC_DECIMALS,
  USDC_MINT,
  buildCreateMintIxs,
  math,
  type CreateLaunchParams,
} from "@terp/sdk";
import BN from "bn.js";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAsync } from "@/hooks/useAsync";
import { useBalances, useLiquidityLock, useMarket } from "@/hooks/useChain";
import { useClient, useProtocol } from "@/hooks/useClient";
import { BATCH_SLOTS_PER_TX, useSendBatch, useSendTx } from "@/hooks/useSendTx";
import { fetchTokenMeta } from "@/lib/chain";
import { PROGRAM_ID } from "@/lib/env";
import {
  PROTOCOL_POLICY,
  atomsToInput,
  describeKeeperFee,
  describePolicy,
  formatActivation,
  formatAtoms,
  formatBps,
  formatLeverage,
  formatMandate,
  formatPrice,
  formatSlots,
  formatUsd,
  parseAtoms,
} from "@/lib/format";
import {
  ACTIVATION_DELAY_SLOTS,
  BINS_PER_POSITION,
  BIN_GROWTH,
  BIN_STEP_BPS,
  DEFAULT_RANGE_MULTIPLE,
  MAX_RANGE_MULTIPLE,
  MIN_RANGE_MULTIPLE,
  POOL_FEE_BPS,
  SEED_SLACK_ATOMS,
  buildSeedPlan,
  grossUp,
  loadSeedSession,
  saleRealizedBps,
  saveSeedSession,
  seedRange,
  startBinId,
  validMultiple,
  type SeedSession,
} from "@/lib/liquidity";
import { AuthorityList } from "./Disclosures";
import { lockHeadline } from "./LiquidityPanel";
import { Address, Notice, Panel, Rows } from "./ui";

// The pool's shape (bin step, base fee, curvature, range, activation delay) is in lib/liquidity.ts.
const DECIMALS = 6;
const U64_MAX = 2n ** 64n - 1n;
/** A conversion always realizes several percent below spot (transfer fee + pool fee + impact), so the floor is wide. */
const MAX_PRICE_DROP_BPS = 1000;
/** How often the pool is re-read while a launch is being set up: the countdown to activation comes from it. */
const POOL_POLL_MS = 10_000;
/** Slots kept spare, on top of the per-transaction allowance, before seeding is allowed to start. */
const SEED_MARGIN_SLOTS = 50;

/**
 * Conversion and redemption limits stored in the launch. Fixed by this UI and shown to the creator
 * before signing; they cannot be changed afterwards.
 */
function launchParams(
  assetId: number,
  supply: bigint,
  creator: bigint,
  pool: bigint,
  initialPrice: bigint,
): CreateLaunchParams {
  const minConvertTokens = supply / 100_000n || 1n;
  const maxConvertTokens = supply / 1_000n > minConvertTokens ? supply / 1_000n : minConvertTokens;
  return {
    assetId,
    totalSupply: supply,
    creatorAllocation: creator,
    poolAllocation: pool,
    initialPrice,
    minConvertTokens,
    maxConvertTokens,
    convertCooldownSlots: 150n,
    maxPriceDropBps: MAX_PRICE_DROP_BPS,
    minDepositUsdc: 10n * 10n ** BigInt(USDC_DECIMALS),
    minRedeemTokens: 10n ** BigInt(DECIMALS),
  };
}

type StepStatus = "done" | "ready" | "blocked";

function Step(props: {
  index: string;
  title: string;
  status: StepStatus;
  blocked?: string;
  signs: string[];
  costs: [string, ReactNode, string?][];
  /** Lead-in to the list of what is signed; a step of several transactions says so here. */
  intro?: string;
  /** Label of the button that opens the review. */
  action?: string;
  onReview: () => void;
  children?: ReactNode;
}) {
  return (
    <li className={`step ${props.status}`}>
      <header>
        <span className="mark" aria-hidden>
          {props.status === "done" ? (
            <svg viewBox="0 0 12 12" focusable="false">
              <path d="M2 6.5 4.8 9.2 10 3.2" />
            </svg>
          ) : (
            props.index
          )}
        </span>
        <h3>{props.title}</h3>
        <span className={`badge ${props.status === "done" ? "good" : ""}`}>
          {props.status === "done" ? "Done" : props.status === "ready" ? "Ready" : "Waiting"}
        </span>
      </header>
      {props.status !== "done" && (
        <>
          <p className="small"><strong>{props.intro ?? "You will sign one transaction that:"}</strong></p>
          <ul className="small">
            {props.signs.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <Rows rows={props.costs} />
          {props.children}
          {props.status === "blocked" && props.blocked && <p className="warn small">{props.blocked}</p>}
          <button className="primary" disabled={props.status !== "ready"} onClick={props.onReview}>
            {props.action ?? "Review transaction"}
          </button>
        </>
      )}
    </li>
  );
}

export function CreateFlow() {
  const client = useClient();
  const protocol = useProtocol();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const sendTx = useSendTx();
  const sendBatch = useSendBatch();
  const router = useRouter();
  const search = useSearchParams();

  // A launch in progress is identified by `?mint=`, so a reload resumes at the right step.
  const [mintKeypair] = useState(() => Keypair.generate());
  const mintParam = search.get("mint");
  const resumed = useMemo(() => {
    try {
      return mintParam ? new PublicKey(mintParam) : null;
    } catch {
      return null;
    }
  }, [mintParam]);
  const mint = resumed ?? mintKeypair.publicKey;

  const launchState = useAsync(() => client.fetchLaunch(mint), mint.toBase58());
  const launch = launchState.data ?? null;
  const market = useMarket(launch?.pool ?? null, mint, POOL_POLL_MS);
  // the vault's positions in the pool; re-read after every seeding attempt rather than on a timer
  const lock = useLiquidityLock(market.data, launch?.address ?? null);
  const balances = useBalances(mint);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [description, setDescription] = useState("");
  const [supplyText, setSupplyText] = useState("1000000000");
  // 5% by default: the creator allocation has to cover at least the transfer tax on seeding the pool
  const [creatorText, setCreatorText] = useState("50000000");
  /** Starting market cap in USD: starting price x total supply. */
  const [capText, setCapText] = useState("10000");
  /** Top of the seeded price range as a multiple of the starting price. */
  const [multipleText, setMultipleText] = useState(String(DEFAULT_RANGE_MULTIPLE));
  // The key the seeded positions' addresses derive from, kept for the browser session (see lib/liquidity.ts).
  const [seedSession, setSeedSession] = useState<SeedSession | null>(null);
  const [seedStored, setSeedStored] = useState(true);
  const [seedLost, setSeedLost] = useState(false);
  // The two permanent choices. Neither has a default: the creator has to pick each one.
  const keeper = protocol.status === "ready" ? protocol.config.keeper : null;
  // Keeper fee: the launch's own once it exists; before, the config's rate, which step 1 copies into the launch.
  const keeperFeeBps = launch ? launch.keeperFeeBps : protocol.status === "ready" ? protocol.config.keeperFeeBps : null;
  const [feeChoice, setFeeChoice] = useState<number | null>(null);
  const [assetChoice, setAssetChoice] = useState<number | null>(null);

  // Leveraged assets the admin has listed. Only needed until the launch exists.
  const markets = useAsync(() => client.fetchMarkets(), launchState.data === null ? "markets" : null);
  const chosenMarket = markets.data?.find((listed) => listed.assetId === assetChoice) ?? null;
  const noMarkets = markets.data !== undefined && markets.data.length === 0;
  // Tax rate and asset: from chain once the launch exists, from the form before.
  const feeBps = launch ? launch.transferFeeBps : feeChoice;
  const assetSymbol = launch ? launch.symbol : (chosenMarket?.symbol ?? null);
  const feeLabel = feeBps !== null ? formatBps(feeBps) : "1% or 3%";
  // Leverage policy: the launch's own copy once it exists, the protocol's before.
  const policy = launch ?? PROTOCOL_POLICY;
  const target = formatLeverage(policy.targetLeverageBps);
  const mandate = launch ? formatMandate(launch) : `${target}-target ${assetSymbol ?? "(asset not chosen)"} long`;

  // Allocation: from chain once the launch exists, from the form before.
  const formSupply = parseAtoms(supplyText, DECIMALS);
  const formCreator = parseAtoms(creatorText, DECIMALS);
  const decimals = launch?.decimals ?? DECIMALS;
  const supply = launch ? launch.initialSupply : formSupply;
  const creatorAllocation = launch ? launch.creatorAllocation : formCreator;
  const poolAllocation =
    launch ? launch.poolAllocation : supply !== null && creatorAllocation !== null ? supply - creatorAllocation : null;
  const meta = useAsync(() => fetchTokenMeta(connection, mint), launch ? `meta:${mint.toBase58()}` : null);
  const ticker = meta.data?.symbol || symbol || "tokens";
  const tokens = (amount: bigint) => `${formatAtoms(amount, decimals)} ${ticker}`;

  const isCreator = !!publicKey && !!launch && publicKey.equals(launch.creator);
  const needWallet = publicKey ? undefined : "Connect a wallet.";

  // ----- Starting price -----
  // The creator states a starting market cap; the pool starts on the first price bin at or above
  // (market cap / supply). Once the launch exists, the bin is the one its reference price was computed from.
  const formCap = parseAtoms(capText, USDC_DECIMALS);
  // USDC atoms per token atom, as an exact decimal string: only used to pick the pool's starting bin
  const formPricePerAtom =
    formCap !== null && formCap > 0n && supply !== null && supply > 0n ? atomsToInput((formCap * 10n ** 18n) / supply, 18) : null;
  const formBinId = formPricePerAtom && Number(formPricePerAtom) > 0 ? startBinId(formPricePerAtom) : null;
  // The bin the reference price recorded by step 1 came from. Known until the first tax conversion moves the reference.
  const recordedBinId =
    launch && launch.tokensConverted === 0n && launch.emaPrice > 0n
      ? Math.round(
          Math.log(((Number(launch.emaPrice) / Number(math.PRICE_SCALE)) * 10_000) / saleRealizedBps(launch.transferFeeBps)) /
            Math.log(BIN_GROWTH),
        )
      : null;
  const activeId = launch ? recordedBinId : formBinId;
  // the pool's exact starting price: USDC atoms per token atom, at the bin the pool is created on
  const binPrice = activeId !== null ? getPriceOfBinByBinId(activeId, BIN_STEP_BPS) : null;
  const startPrice = binPrice ? binPrice.toNumber() * 10 ** (decimals - USDC_DECIMALS) : null;
  const startCap = startPrice !== null && supply !== null ? startPrice * (Number(supply) / 10 ** decimals) : null;
  // What a sale into the pool realizes at that price, in the program's units (x 1e12). Stored in the launch
  // by step 1 as the first reference price for tax conversions.
  // initialPrice = pool start price x 1e12 x (1 - transfer tax - pool base fee)
  const initialPrice =
    binPrice && feeBps !== null
      ? BigInt(binPrice.mul(math.PRICE_SCALE.toString()).mul(saleRealizedBps(feeBps)).div(10_000).floor().toFixed(0))
      : null;
  const realizedPrice =
    initialPrice !== null ? (Number(initialPrice) / Number(math.PRICE_SCALE)) * 10 ** (decimals - USDC_DECIMALS) : null;

  // Guard: the pool must start on the bin the recorded reference price came from. Recomputing the reference
  // from that bin has to give the recorded number back; it does not if the launch was created for another
  // pool shape (another bin step or base fee), and then this page must not create the pool.
  const priceMismatch =
    !!launch &&
    !launch.pool &&
    (initialPrice === null ||
      (initialPrice > launch.emaPrice ? initialPrice - launch.emaPrice : launch.emaPrice - initialPrice) * 200n > launch.emaPrice);
  const activation = market.data?.activation ?? null;
  // The same guard once the pool exists: before trading opens its active bin cannot have moved.
  const poolBinMismatch =
    !!market.data && !!activation && !activation.open && recordedBinId !== null && market.data.dlmm.lbPair.activeId !== recordedBinId;

  // ----- Seeded range and what seeding costs in tokens -----
  const lockData = lock.data;
  const vaultPositions = lockData?.positions.length ?? 0;
  // once positions exist, the range they were started with is the range
  const multipleLocked = !!seedSession && seedSession.multiple !== null && vaultPositions > 0;
  const formMultiple = /^\d+(\.\d+)?$/.test(multipleText.trim()) ? Number(multipleText) : NaN;
  const multiple = multipleLocked ? (seedSession.multiple as number) : formMultiple;
  const multipleOk = validMultiple(multiple);
  const range = activeId !== null && multipleOk ? seedRange(activeId, multiple, decimals) : null;
  // The transfer tax applies to the seed deposit: the pool receives the whole pool allocation and
  // this much more leaves the creator's wallet, withheld as tax for the vault.
  const seedTax = feeBps !== null && poolAllocation !== null && poolAllocation > 0n ? grossUp(poolAllocation, feeBps) - poolAllocation : null;
  const minCreatorAllocation = seedTax !== null ? seedTax + SEED_SLACK_ATOMS : null;

  const formProblems = launch
    ? []
    : [
        !name.trim() || name.length > 32 ? "Name is required (up to 32 characters)." : null,
        !symbol.trim() || symbol.length > 10 ? "Ticker is required (up to 10 characters)." : null,
        !/^(https?|ipfs|ar):\/\/\S+$/.test(uri) || uri.length > 200
          ? "Metadata URI must be an https://, ipfs:// or ar:// link (up to 200 characters)."
          : null,
        description.length > 200 ? "Description is limited to 200 characters so the transaction fits." : null,
        supply === null || supply <= 0n || supply > U64_MAX ? "Supply must be a positive number that fits the token's 64-bit limit." : null,
        creatorAllocation === null ? "Creator allocation must be a number." : null,
        poolAllocation !== null && poolAllocation <= 0n ? "The pool allocation must be above zero: creator allocation must be less than the supply." : null,
        creatorAllocation !== null && minCreatorAllocation !== null && creatorAllocation < minCreatorAllocation && feeBps !== null
          ? `Creator allocation must be at least ${formatAtoms(minCreatorAllocation, DECIMALS)}: seeding the pool is a taxed transfer, so the ${formatBps(feeBps)} tax on the pool allocation leaves your wallet on top of it.`
          : null,
        feeChoice === null ? "Choose the transfer tax: 1% or 3%. It cannot be changed afterwards." : null,
        noMarkets
          ? "No leveraged assets are listed yet, so a launch cannot be created."
          : !chosenMarket
            ? "Choose the asset the vault goes long. It cannot be changed afterwards."
            : null,
        supply !== null && supply > 0n && formBinId === null
          ? "Enter a starting market cap above zero below: the launch records the pool's starting price, so it has to be known now."
          : null,
        initialPrice !== null && initialPrice < 1_000n
          ? "That starting price is too low to be recorded precisely. Raise the starting market cap or lower the supply."
          : null,
      ].filter((problem): problem is string => problem !== null);

  // ----- Step 2: what DLMM wants from the pool creator's wallet -----
  // "Launch owner proof": a non-zero balance of BOTH tokens, or pool creation fails
  // (MissingTokenAmountAsTokenLaunchProof). None of the USDC is deposited.
  const missingProof = !balances.data
    ? null
    : balances.data.usdc === 0n
      ? "Your wallet holds no USDC. Meteora only lets a wallet create this pool if it holds some of both tokens. Any amount will do (one cent is enough) and none of it is deposited or spent."
      : balances.data.token === 0n
        ? `Your wallet holds no ${ticker}. Meteora only lets a wallet create this pool if it holds some of both tokens.`
        : null;

  // ----- Step 3: seeding state, all of it read from chain -----
  const vaultHolds = !!lockData && (lockData.vaultTokens > 0n || lockData.vaultUsdc > 0n);
  // before trading opens nothing can leave the positions, so their token total is what was seeded
  const fullySeeded =
    !!lockData && poolAllocation !== null && lockData.vaultTokens + poolAllocation / 100_000n + 1_000n >= poolAllocation;
  const seedDone = !!launch?.pool && !!lockData && !!activation && (activation.open ? vaultHolds : fullySeeded);
  // trading opened and the vault owns nothing in the pool: a locked seeding is no longer possible
  const missedActivation = !!launch?.pool && !!lockData && !!activation && activation.open && !vaultHolds;

  // The base key: restored from this browser session, or made once when there is nothing on chain yet.
  const poolSet = !!launch?.pool;
  const lockLoaded = !!lockData;
  useEffect(() => {
    if (!poolSet || !isCreator || !lockLoaded || seedSession || seedLost) return;
    const stored = loadSeedSession(mint);
    if (stored) {
      setSeedSession(stored);
    } else if (vaultPositions > 0) {
      // positions exist that were derived from a key this browser no longer has
      setSeedLost(true);
    } else {
      const fresh = { base: Keypair.generate(), multiple: null };
      setSeedStored(saveSeedSession(mint, fresh));
      setSeedSession(fresh);
    }
  }, [poolSet, isCreator, lockLoaded, seedSession, seedLost, vaultPositions, mint]);

  // What is still to be sent. Rebuilt from chain whenever the vault's positions change, so a reload resumes.
  const seedPlan = useAsync(
    () =>
      buildSeedPlan({
        connection,
        dlmm: market.data!.dlmm,
        mint,
        launch: launch!.address,
        creator: publicKey!,
        base: seedSession!.base,
        amount: poolAllocation!,
        multiple,
      }),
    launch?.pool && isCreator && publicKey && market.data?.tokenIsX && lockData && seedSession && multipleOk && poolAllocation && !missedActivation
      ? `seed:${seedSession.base.publicKey.toBase58()}:${multiple}:${vaultPositions}:${lockData.vaultTokens}`
      : null,
  );
  const remainingTxs = seedPlan.data?.transactions.length ?? null;
  const seedTotal = seedPlan.data?.total ?? range?.transactions ?? null;
  const seedSent = seedPlan.data ? Math.max(seedPlan.data.total - seedPlan.data.transactions.length, 0) : null;
  // tokens the rest of the seeding takes from the wallet: what the pool still lacks, plus the tax on it
  const seedNeeds =
    feeBps !== null && poolAllocation !== null && lockData
      ? grossUp(poolAllocation > lockData.vaultTokens ? poolAllocation - lockData.vaultTokens : 0n, feeBps) + SEED_SLACK_ATOMS
      : null;
  const shortOfTokens = !!balances.data && seedNeeds !== null && balances.data.token < seedNeeds;
  const slotsLeft = activation && !activation.open ? Number(activation.point - activation.now) : 0;
  const tooLate = remainingTxs !== null && slotsLeft < remainingTxs * BATCH_SLOTS_PER_TX + SEED_MARGIN_SLOTS;
  // trading opened with part of the seeding unsent
  const seedIncomplete = !!activation?.open && vaultHolds && remainingTxs !== null && remainingTxs > 0;

  const reviewCreate = async () => {
    if (!publicKey || supply === null || creatorAllocation === null || poolAllocation === null) return;
    if (initialPrice === null || initialPrice <= 0n || startPrice === null || realizedPrice === null) return;
    if (feeChoice === null || !chosenMarket || keeperFeeBps === null) return;
    const params = launchParams(chosenMarket.assetId, supply, creatorAllocation, poolAllocation, initialPrice);
    const signature = await sendTx({
      title: `Create ${symbol} and its launch vault`,
      rows: [
        ["Mint address", mint.toBase58()],
        ["Transfer tax (permanent)", `${formatBps(feeChoice)} of every transfer, to this token's vault`],
        [
          "Leveraged asset (permanent)",
          `${chosenMarket.symbol}: the vault holds a ${chosenMarket.symbol} long on Phoenix, aiming for ${target} (asset id ${chosenMarket.assetId})`,
        ],
        [
          "Leverage policy (permanent)",
          `aims to stay open and close to ${target}, in profit or not; tax always adds collateral; under ${formatLeverage(policy.minLeverageBps)} the position is topped up to ${target}; above ${formatLeverage(policy.maxLeverageBps)} any wallet can cut it to ${formatLeverage(policy.deleverageToBps)}`,
        ],
        [
          "Keeper fee (permanent)",
          `${formatBps(keeperFeeBps)} of the USDC every tax sale brings in, paid to the Terp platform treasury; the rest goes to the vault`,
        ],
        ["Supply minted to your wallet", tokens(supply)],
        ["Declared creator allocation", tokens(creatorAllocation)],
        ["Declared pool allocation", tokens(poolAllocation)],
        [
          "Transfer tax on seeding the pool (step 3)",
          seedTax !== null
            ? `${tokens(seedTax)}, out of your creator allocation: the vault starts with these as tax tokens and the keeper sells them into the pool over time`
            : "n/a",
        ],
        ["USDC spent", "none, in this step or any other; step 2 only needs your wallet to hold some"],
        ["Tax batch sold per conversion", `${tokens(params.minConvertTokens)} to ${tokens(params.maxConvertTokens)}`],
        ["Conversion cooldown", `${params.convertCooldownSlots} slots (${formatSlots(params.convertCooldownSlots, SLOT_MS)})`],
        [
          "Pool starting price (set in step 2)",
          `${formatPrice(startPrice)} per token${startCap !== null ? `, a starting market cap of about ${formatPrice(startCap)}` : ""}`,
        ],
        [
          `Initial reference price: start price less ${formatBps(feeChoice)} transfer tax and ${formatBps(POOL_FEE_BPS)} pool base fee`,
          `${formatPrice(realizedPrice)} per token (initialPrice ${params.initialPrice})`,
        ],
        ["Max price drop per conversion, below the reference", formatBps(params.maxPriceDropBps)],
        [
          "Tax conversion and deployment",
          keeper
            ? `sent by the Terp keeper (${keeper.toBase58()}); converted USDC goes to the vault, less the keeper fee`
            : "sent by the Terp keeper; converted USDC goes to the vault, less the keeper fee",
        ],
        ["Minimum collateral deposit", formatUsd(params.minDepositUsdc)],
        ["Minimum redemption", tokens(params.minRedeemTokens)],
      ],
      notes: [
        "Signed by your wallet and by the new mint's keypair, generated in this browser and used only for this transaction.",
        `After this transaction the mint authority, the metadata, the ${formatBps(feeChoice)} transfer tax, the leveraged asset (${chosenMarket.symbol}), the leverage policy and the ${formatBps(keeperFeeBps)} keeper fee can never be changed, by you or anyone else.`,
        `The tax tokens go to this token's vault; no wallet, yours included, can collect them. When they are sold, ${formatBps(keeperFeeBps)} of the USDC goes to the platform treasury and the rest to the vault. The fee is the protocol's current rate, copied into the launch by this transaction; if the admin changes the rate before it confirms, the launch gets the new one (never more than ${formatBps(MAX_KEEPER_FEE_BPS)}).`,
        `Leverage is held near ${target} even while ${chosenMarket.symbol} is below the position's entry price, so liquidation is never far away (roughly a 15–20% adverse move from ${target}).`,
        "The reference price is what a tax sale into the pool realizes at launch. The program refuses a conversion priced more than the maximum drop below it (per cooldown elapsed), and then follows a running average of conversions. Step 2 creates the pool on the price bin this number was computed from.",
        "The pool will hold tokens only at the start: no USDC of yours goes in. The pool allocation is deposited in step 3 into positions owned by the vault and locked for good, so you cannot take it back. The transfer tax on that deposit is paid on top, from the tokens you keep.",
      ],
      build: async () => ({
        instructions: [
          ...(await buildCreateMintIxs(
            connection,
            publicKey,
            mint,
            {
              name: name.trim(),
              symbol: symbol.trim(),
              uri,
              description: description.trim(),
              decimals: DECIMALS,
              transferFeeBps: feeChoice,
              totalSupply: supply,
            },
            PROGRAM_ID,
          )),
          await client.createLaunchIx(publicKey, mint, params),
        ],
        signers: [mintKeypair],
      }),
    });
    if (signature) {
      router.replace(`/create?mint=${mint.toBase58()}`);
      launchState.reload();
      balances.reload();
    }
  };

  const reviewPool = async () => {
    if (!publicKey || activeId === null || startPrice === null || priceMismatch || missingProof) return;
    const [pool] = deriveCustomizablePermissionlessLbPair(mint, USDC_MINT, DLMM_PROGRAM_ID);
    const signature = await sendTx({
      title: "Create the Meteora DLMM pool",
      rows: [
        ["Pool address", pool.toBase58()],
        ["Pair", `${ticker} / USDC`],
        ["Starting price", `${formatPrice(startPrice)} per token`],
        ["Bin step", formatBps(BIN_STEP_BPS)],
        ["Base swap fee", `${formatBps(POOL_FEE_BPS)}, always charged in USDC; Meteora adds a variable part that grows with the price bins a swap crosses`],
        [
          "Trading opens",
          `${ACTIVATION_DELAY_SLOTS.toLocaleString("en-US")} slots after the slot this transaction is built at (${formatSlots(BigInt(ACTIVATION_DELAY_SLOTS), SLOT_MS)}); the exact slot is shown once the pool exists`,
        ],
        ["Tokens and USDC spent", "none"],
      ],
      notes: [
        "Also records this pool in the launch (set_pool). That can be done once and cannot be changed.",
        `Step 3 has to be finished before trading opens. Positions owned by the vault and locked can only be created while the pool is not yet active, so have your wallet ready: you have about ${formatSlots(BigInt(ACTIVATION_DELAY_SLOTS), SLOT_MS).replace("~", "")} from this transaction to approve and confirm the seeding. If it is not done by then, this launch cannot be seeded as locked any more.`,
        "Meteora requires the wallet that creates the pool to hold some of both tokens. Your USDC is only looked at; none is taken.",
      ],
      build: async () => {
        // Trading opens at the activation slot. Positions can only be created on behalf of another
        // owner before that, so the pool is created first, seeded, and opens afterwards.
        const activationPoint = new BN((await connection.getSlot("confirmed")) + ACTIVATION_DELAY_SLOTS);
        const transaction = await DLMM.createCustomizablePermissionlessLbPair2(
          connection,
          new BN(BIN_STEP_BPS),
          mint,
          USDC_MINT,
          new BN(activeId),
          new BN(POOL_FEE_BPS),
          ActivationType.Slot,
          false,
          publicKey,
          activationPoint,
          false,
          undefined,
          CollectFeeMode.OnlyY, // the pool's swap fee is always taken in USDC
        );
        return { instructions: [...transaction.instructions, await client.setPoolIx(publicKey, mint, pool)] };
      },
    });
    if (signature) {
      launchState.reload();
      balances.reload();
    }
  };

  const reviewSeed = async () => {
    if (!publicKey || !launch || !market.data || !activation || !seedSession || !seedPlan.data) return;
    if (poolAllocation === null || feeBps === null || seedNeeds === null || !multipleOk) return;
    const { dlmm } = market.data;
    const plan = seedPlan.data;
    // from here on the range belongs to this base key: a reload resumes with both
    const session = { base: seedSession.base, multiple };
    const stored = saveSeedSession(mint, session);
    setSeedStored(stored);
    setSeedSession(session);
    const remaining = plan.transactions.length;
    const confirmed = await sendBatch({
      title: remaining < plan.total ? "Continue seeding the pool (tokens only, locked)" : "Seed the pool with tokens only, locked",
      rows: [
        ["Tokens the pool receives in total", tokens(poolAllocation)],
        [
          `${formatBps(feeBps)} transfer tax on the deposit, on top`,
          `${tokens(grossUp(poolAllocation, feeBps) - poolAllocation)}: withheld in the pool's token account, swept to the vault, and sold into the pool by the keeper over time`,
        ],
        ["Still to leave your wallet", `up to ${tokens(seedNeeds)}`],
        ["USDC you send", "none"],
        ["Price range", `${formatPrice(plan.range.startPrice)} to ${formatPrice(plan.range.topPrice)} per token, over ${plan.range.binCount} bins of ${formatBps(BIN_STEP_BPS)}`],
        ["Position owner", `the vault (${launch.address.toBase58()})`],
        ["Lock release", "never: the liquidity cannot be withdrawn by you or anyone else"],
        ["Swap fees of the positions", `paid only to the vault's USDC account (${launch.vaultUsdc.toBase58()})`],
        ["Operator", "your wallet: it deposits the tokens now and can later trigger fee claims into the vault; it cannot withdraw"],
        ["Transactions", `${remaining} to send${remaining < plan.total ? ` (${plan.total - remaining} of ${plan.total} already done)` : ""}`],
        ["SOL rent for positions and price bins (Meteora SDK estimate)", `${formatAtoms(plan.rentLamports, 9)} SOL, not returned: the positions are never closed`],
        ["Must be finished before", `trading opens at ${formatActivation(activation, SLOT_MS)}`],
      ],
      notes: [
        "This cannot be undone. The tokens go into positions owned by the launch vault with a lock that never releases. Your wallet is only their operator, which Meteora does not let remove locked liquidity, and the vault program has no instruction that withdraws it.",
        `The vault starts with the tax withheld from this deposit. The keeper sells it into the pool in batches, which is sell pressure from the first conversions on.`,
        stored
          ? "The position transactions are also signed by a key made in this browser and kept for this browser session only. If the page reloads, come back to this step in the same tab and it continues where it stopped."
          : "The position transactions are also signed by a key made in this browser. Your browser refused to store it, so do not reload or close this page until the step is done: it could not be resumed.",
      ],
      deadlineSlot: Number(activation.point),
      deadlineLabel: "the pool opens for trading",
      build: async () =>
        (
          await buildSeedPlan({
            connection,
            dlmm,
            mint,
            launch: launch.address,
            creator: publicKey,
            base: session.base,
            amount: poolAllocation,
            multiple,
          })
        ).transactions,
    });
    if (confirmed !== null) {
      market.reload();
      lock.reload();
      balances.reload();
      seedPlan.reload();
    }
  };

  const reviewTrader = async () => {
    if (!publicKey) return;
    const signature = await sendTx({
      title: "Register the vault's Phoenix trader account",
      rows: [
        ["Trader authority", "the launch vault PDA (not your wallet)"],
        ["Tokens and USDC spent", "none"],
      ],
      notes: ["Creates the Phoenix perpetuals trader account owned by the vault, and the vault's account for Phoenix's canonical USDC."],
      build: async () => ({ instructions: [await client.registerTraderIx(publicKey, mint)] }),
    });
    if (signature) launchState.reload();
  };

  if (resumed && launchState.data === undefined && !launchState.error) return <p className="muted">Loading launch…</p>;
  if (launchState.error) {
    return (
      <Notice tone="bad" title="Could not read the launch">
        <p>{launchState.error}</p>
        <button onClick={launchState.reload}>Retry</button>
      </Notice>
    );
  }
  if (resumed && !launch) {
    return (
      <Notice title="No launch for this mint">
        <p>
          <span className="mono">{resumed.toBase58()}</span> has no launch account. <Link href="/create">Start a new launch.</Link>
        </p>
      </Notice>
    );
  }

  const swapProgramMismatch = protocol.status === "ready" && !protocol.config.swapProgram.equals(DLMM_PROGRAM_ID);

  return (
    <>
      {launch ? (
        <Panel title="Launch in progress">
          <Rows
            rows={[
              ["Mint", <Address key="mint" value={launch.mint} full />],
              ["Creator", <Address key="creator" value={launch.creator} />],
              ["Transfer tax", formatBps(launch.transferFeeBps), "permanent; goes to this token's vault"],
              ["Vault position", formatMandate(launch), "permanent; on Phoenix perpetuals"],
              ["Keeper fee", formatBps(launch.keeperFeeBps), "permanent; share of converted tax paid to the platform"],
              ["Supply", formatAtoms(launch.initialSupply, decimals)],
              ["Creator allocation", formatAtoms(launch.creatorAllocation, decimals)],
              ["Pool allocation", formatAtoms(launch.poolAllocation, decimals)],
              ["Pool", launch.pool ? <Address key="pool" value={launch.pool} /> : "not created yet"],
              ...(activation
                ? ([
                    [
                      activation.open ? "Trading opened at" : "Trading opens at",
                      formatActivation(activation, SLOT_MS),
                      activation.open ? undefined : "seeding (step 3) has to be confirmed before this",
                    ],
                  ] as [string, ReactNode, string?][])
                : []),
              ...(launch.pool
                ? ([
                    [
                      "Pool liquidity",
                      lockData ? lockHeadline(lockData).label : lock.error ? "could not be read" : "reading…",
                      "from the pool's position accounts",
                    ],
                  ] as [string, ReactNode, string?][])
                : []),
            ]}
          />
          <p className="small">
            <Link href={`/token/${launch.mint.toBase58()}`}>Open the token page</Link>
          </p>
        </Panel>
      ) : (
        <Panel title="Token">
          <div className="form">
            <label>
              <span>Name</span>
              <input value={name} maxLength={32} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>Ticker</span>
              <input value={symbol} maxLength={10} onChange={(event) => setSymbol(event.target.value)} />
            </label>
            <label className="wide">
              <span>
                Image / metadata URI <small>a JSON file with the token&apos;s image; stored on the mint, immutable</small>
              </span>
              <input value={uri} maxLength={200} placeholder="https://…" onChange={(event) => setUri(event.target.value)} />
            </label>
            <label className="wide">
              <span>Description</span>
              <textarea value={description} maxLength={200} rows={2} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <label>
              <span>
                Fixed supply <small>{DECIMALS} decimals; can never be increased</small>
              </span>
              <input inputMode="decimal" value={supplyText} onChange={(event) => setSupplyText(event.target.value)} />
            </label>
            <label>
              <span>
                Creator allocation <small>tokens not put in the pool; the tax on seeding the pool comes out of them</small>
              </span>
              <input inputMode="decimal" value={creatorText} onChange={(event) => setCreatorText(event.target.value)} />
            </label>
          </div>
          {supply !== null && creatorAllocation !== null && poolAllocation !== null && supply > 0n && (
            <Rows
              rows={[
                ["Creator allocation", `${tokens(creatorAllocation)} (${formatBps((creatorAllocation * 10_000n) / supply)})`],
                ["Pool allocation", `${tokens(poolAllocation)} (${formatBps((poolAllocation * 10_000n) / supply)})`, "supply − creator allocation; deposited into the pool in step 3 and locked"],
                ["Total", tokens(supply), "the two always add up to the supply"],
                [
                  "Minimum creator allocation",
                  minCreatorAllocation !== null ? tokens(minCreatorAllocation) : "choose the transfer tax first",
                  "the transfer tax on seeding the pool is paid from it, on top of the pool allocation",
                ],
              ]}
            />
          )}
        </Panel>
      )}

      {!launch && (
        <Panel title="Tax and leveraged asset" aside="two permanent choices">
          <p className="small">
            Tax tokens from every transfer go to the token&apos;s own vault. The vault sells them in the token&apos;s
            pool for USDC. {describeKeeperFee(keeperFeeBps)} The vault deposits its USDC on Phoenix and holds a long on
            the asset you choose here. {describePolicy(policy)} The Terp keeper decides when tax is sold and deployed; no wallet, yours and the
            keeper&apos;s included, can withdraw it.
          </p>
          <fieldset className="choice">
            <legend>
              Transfer tax <small>charged on every transfer, buys and sells included; fixed on the mint for good</small>
            </legend>
            <div>
              {TRANSFER_FEE_TIERS.map((tier) => (
                <label key={tier}>
                  <input
                    type="radio"
                    name="transfer-tax"
                    checked={feeChoice === tier}
                    onChange={() => setFeeChoice(tier)}
                  />
                  <span>{formatBps(tier)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {markets.error ? (
            <Notice tone="bad" title="Could not load the listed assets">
              <p>{markets.error}</p>
              <button onClick={markets.reload}>Retry</button>
            </Notice>
          ) : markets.data === undefined ? (
            <p className="muted">Loading the listed assets…</p>
          ) : noMarkets ? (
            <Notice tone="warn" title="No leveraged assets listed yet">
              <p>
                The protocol admin has not listed any Phoenix perpetual market, so there is nothing for a vault to go
                long. A launch cannot be created until at least one asset is listed.
              </p>
              <button onClick={markets.reload}>Check again</button>
            </Notice>
          ) : (
            <fieldset className="choice">
              <legend>
                Leveraged asset <small>the vault&apos;s {target}-target long; fixed for good</small>
              </legend>
              <div>
                {markets.data.map((listed) => (
                  <label key={listed.assetId}>
                    <input
                      type="radio"
                      name="leveraged-asset"
                      checked={assetChoice === listed.assetId}
                      onChange={() => setAssetChoice(listed.assetId)}
                    />
                    <span>{listed.symbol}</span>
                  </label>
                ))}
              </div>
              <p className="muted small">
                These are the Phoenix perpetual markets the protocol admin has listed. A listing is permanent.
              </p>
            </fieldset>
          )}

          <Rows
            rows={[
              ["Transfer tax", feeChoice !== null ? formatBps(feeChoice) : "not chosen", "to this token's vault"],
              ["Vault position", chosenMarket ? mandate : "not chosen", "opened with the converted tax"],
              [
                "Keeper fee",
                keeperFeeBps !== null ? `${formatBps(keeperFeeBps)} of converted tax` : "reading the protocol config…",
                "set by the platform, not by you; paid to its treasury out of every tax sale and fixed for this launch at creation",
              ],
            ]}
          />
        </Panel>
      )}

      {formProblems.length > 0 && (
        <div aria-live="polite">
          {formProblems.map((problem) => (
            <p key={problem} className="bad small">{problem}</p>
          ))}
        </div>
      )}

      {missedActivation && (
        <Notice tone="bad" title="Seeding did not happen before trading opened">
          <p>
            The pool opened for trading at {activation && formatActivation(activation, SLOT_MS)} and the vault owns no
            liquidity in it. Meteora only lets positions be created for another owner, here the vault, before a pool
            is active, so this launch can no longer be seeded as locked. Nothing more can be done from this page: it
            will not create an unlocked position in your wallet instead. The pool recorded in the launch cannot be
            replaced; a new launch is the way to start over.
          </p>
        </Notice>
      )}
      {seedIncomplete && (
        <Notice tone="bad" title="Trading opened before the seeding was finished">
          <p>
            {seedSent} of {seedTotal} seeding transactions were confirmed before the pool became active. What was
            deposited is in the vault&apos;s locked positions and trades normally; the rest of the pool allocation is
            still in your wallet and can no longer be added as locked liquidity from this page.
          </p>
        </Notice>
      )}
      {seedLost && !seedDone && !missedActivation && (
        <Notice tone="bad" title="The seeding cannot be continued in this browser session">
          <p>
            The vault already owns {vaultPositions} position{vaultPositions === 1 ? "" : "s"} in this pool, created with
            a key that was kept only in the browser tab that started the seeding. Without it this page would create a
            second set of positions and deposit twice, so it stops here. If that tab is still open, continue there.
          </p>
        </Notice>
      )}
      {poolBinMismatch && (
        <Notice tone="warn" title="The pool does not start at the price recorded in step 1">
          <p>
            The launch&apos;s reference price was computed from price bin {recordedBinId}; the pool recorded for it
            starts on bin {market.data?.dlmm.lbPair.activeId}. The first tax conversions are checked against the
            recorded reference, which cannot be changed.
          </p>
        </Notice>
      )}

      {!seedDone && !missedActivation && (
        <Panel title="Starting price and liquidity" aside="tokens only; no USDC from you">
          <div className="form">
            {!launch && (
              <label>
                <span>
                  Starting market cap (USD) <small>starting price × total supply</small>
                </span>
                <input inputMode="decimal" value={capText} onChange={(event) => setCapText(event.target.value)} />
              </label>
            )}
            <label>
              <span>
                Top of the price range{" "}
                <small>
                  as a multiple of the starting price, {MIN_RANGE_MULTIPLE} to {MAX_RANGE_MULTIPLE}
                  {multipleLocked ? "; fixed when seeding started" : ""}
                </small>
              </span>
              <input
                inputMode="decimal"
                value={multipleLocked ? String(multiple) : multipleText}
                disabled={multipleLocked}
                onChange={(event) => setMultipleText(event.target.value)}
              />
            </label>
          </div>
          {!multipleOk && (
            <p className="bad small">
              The range multiple must be a number between {MIN_RANGE_MULTIPLE} and {MAX_RANGE_MULTIPLE}.
            </p>
          )}
          {launch && !launch.pool && priceMismatch && (
            <Notice tone="bad" title="This launch was not recorded for the pool this page creates">
              <p>
                Step 2 creates a pool with a {formatBps(BIN_STEP_BPS)} bin step and a {formatBps(POOL_FEE_BPS)} base
                fee, starting on the price bin the launch&apos;s reference price was computed from. The reference
                recorded for this launch does not correspond to any such bin, and it cannot be changed, so the pool
                is not created here: tax conversions would be checked against the wrong reference.
              </p>
            </Notice>
          )}
          {startPrice !== null && poolAllocation !== null && poolAllocation > 0n ? (
            <>
              <p>
                The pool starts at <strong>{formatPrice(startPrice)} per token</strong>
                {startCap !== null && <>, a market cap of about {formatPrice(startCap)}</>}. You put in{" "}
                <strong>{tokens(poolAllocation)}</strong> and <strong>no USDC</strong>. The tokens are offered at rising
                prices{range && <>, up to about {formatPrice(range.topPrice)} (just under {multiple}x the start)</>}; buyers&apos; USDC
                fills the pool as the price climbs.
              </p>
              <Rows
                rows={[
                  ["Starting price", `${formatPrice(startPrice)} per token`, launch ? "the price bin recorded by step 1" : "rounded up to the nearest price bin"],
                  ["Starting market cap", startCap !== null ? formatPrice(startCap) : "n/a", "starting price × total supply"],
                  [
                    "Price range seeded",
                    range ? `${formatPrice(range.startPrice)} to ${formatPrice(range.topPrice)}` : "n/a",
                    range ? `${range.binCount} price bins of ${formatBps(BIN_STEP_BPS)} each` : undefined,
                  ],
                  [
                    "Seeding transactions (step 3)",
                    range
                      ? `${range.transactions}: 1 proof + ${range.positions} to create positions + ${range.positions} deposits`
                      : "n/a",
                    `one position covers ${BINS_PER_POSITION} bins`,
                  ],
                  [
                    "Transfer tax on seeding",
                    seedTax !== null ? tokens(seedTax) : "choose the tax first",
                    "paid from your creator allocation on top of the pool allocation; the vault starts with it as tax tokens",
                  ],
                  [
                    "Tokens you keep after seeding",
                    creatorAllocation !== null && seedTax !== null && creatorAllocation >= seedTax
                      ? `about ${tokens(creatorAllocation - seedTax)}`
                      : "n/a",
                    "creator allocation less the tax on seeding",
                  ],
                ]}
              />
              {!launch && minCreatorAllocation !== null && creatorAllocation !== null && creatorAllocation < minCreatorAllocation && supply !== null && (
                <p className="small">
                  <button onClick={() => setCreatorText(atomsToInput(minCreatorAllocation, DECIMALS))}>
                    Set the creator allocation to the minimum, {formatAtoms(minCreatorAllocation, DECIMALS)}
                  </button>
                </p>
              )}
            </>
          ) : (
            !launch && <p className="bad small">Enter a starting market cap above zero.</p>
          )}
          <ul className="small">
            <li>
              <strong>The liquidity is locked for good.</strong> Step 3 puts the pool allocation into positions owned
              by the token&apos;s vault with a lock that never releases. You cannot withdraw it and neither can anyone
              else: your wallet is only the positions&apos; operator, and the vault program has no instruction that
              withdraws. The token page shows this from chain.
            </li>
            <li>
              This is the final pool from the first trade. There is no bonding curve that later migrates somewhere
              else, and the {feeLabel} transfer tax applies from the first trade.
            </li>
            <li>
              Seeding is a taxed transfer. The pool receives the whole pool allocation; the {feeLabel} tax on it
              {seedTax !== null && <> ({tokens(seedTax)})</>} leaves your wallet on top. The vault starts with those
              tokens as tax, and the keeper sells them into the pool over time.
            </li>
            <li>
              The pool&apos;s swap fee is charged in USDC and goes to the locked positions. Only your wallet can
              trigger a claim, and Meteora pays it only to the vault, where it becomes vault equity. You earn nothing
              from it. The fee is not flat: on top of the {formatBps(POOL_FEE_BPS)} base, Meteora charges more the
              more price bins a swap crosses, so large early buys pay much more (about 8% for one buy that crossed
              about 65 bins in a local test).
            </li>
            <li>
              Trading opens about {formatSlots(BigInt(ACTIVATION_DELAY_SLOTS), SLOT_MS).replace("~", "")} after step 2
              confirms, and step 3 has to be confirmed before that: the vault&apos;s positions can only be created
              while the pool is not yet active. If it is not, this launch cannot be seeded as locked any more.
            </li>
            <li>
              Step 2 needs your wallet to hold a little USDC (any amount): Meteora only lets a wallet create the pool
              if it holds some of both tokens. None of it is deposited.
            </li>
            <li>
              Pool liquidity is separate from perp collateral. It is not part of vault equity and is not redemption
              backing. Others can add their own liquidity to the pool; theirs is not locked.
            </li>
          </ul>
        </Panel>
      )}

      <Panel title="Who controls what">
        <AuthorityList
          vault={launch ? <Address value={launch.address} /> : undefined}
          transferFeeBps={feeBps ?? undefined}
        />
        <p className="muted small">
          The vault program verifies the mint&apos;s authorities and fee when the launch is created and refuses mints
          that differ. The declared allocation is only checked to add up.
        </p>
      </Panel>

      {swapProgramMismatch && (
        <Notice tone="warn" title="Swap program mismatch">
          <p>The protocol is configured for a swap program other than Meteora DLMM, so recording a DLMM pool will fail.</p>
        </Notice>
      )}

      <Panel title="Steps" aside="each is reviewed and approved separately">
        <ol className="steps">
          <Step
            index="1"
            title="Create the token and its launch vault"
            status={
              launch
                ? "done"
                : publicKey && formProblems.length === 0 && initialPrice !== null && initialPrice > 0n && keeperFeeBps !== null
                  ? "ready"
                  : "blocked"
            }
            blocked={
              needWallet ??
              (noMarkets
                ? "No leveraged assets are listed yet, so a launch cannot be created."
                : formProblems.length === 0 && keeperFeeBps === null
                  ? "The protocol config has not loaded, so the keeper fee this launch would get is not known yet."
                  : "Complete the token form and the two permanent choices above.")
            }
            signs={[
              `creates the Token-2022 mint with the immutable ${feeLabel} transfer tax and on-mint metadata`,
              "mints the whole supply to your wallet, then removes the mint and metadata authorities",
              `creates the launch account and the vault's token accounts, and records the leveraged asset (${assetSymbol ?? "not chosen yet"}), the leverage policy, the keeper fee, the conversion limits and the reference price (create_launch)`,
            ]}
            costs={[
              ["Tokens", supply !== null ? `${tokens(supply)} minted to you` : "n/a"],
              ["Transfer tax", feeBps !== null ? formatBps(feeBps) : "not chosen", "permanent"],
              ["Vault position", assetSymbol ? mandate : "not chosen", "permanent"],
              [
                "Keeper fee",
                keeperFeeBps !== null ? `${formatBps(keeperFeeBps)} of converted tax, to the platform` : "not known yet",
                "permanent",
              ],
              ["USDC", "none"],
              ["SOL", "rent for 6 new accounts + network fee", "exact amount is simulated before you sign"],
              [
                "Initial reference price (initialPrice)",
                realizedPrice !== null ? `${formatPrice(realizedPrice)} per token` : "n/a",
                `what a tax sale realizes at launch: the pool's starting price less the ${feeLabel} transfer tax and the ${formatBps(POOL_FEE_BPS)} pool base fee`,
              ],
              [
                "Max price drop per conversion",
                formatBps(MAX_PRICE_DROP_BPS),
                "a conversion priced further below the reference is refused; fixed at launch",
              ],
            ]}
            onReview={reviewCreate}
          />
          <Step
            index="2"
            title="Create the liquidity pool and record it"
            status={
              launch?.pool
                ? "done"
                : launch && isCreator && activeId !== null && !priceMismatch && balances.data && !missingProof
                  ? "ready"
                  : "blocked"
            }
            blocked={
              !launch
                ? "Complete step 1 first."
                : needWallet ??
                  (!isCreator
                    ? "Only the launch creator's wallet can record the pool."
                    : priceMismatch
                      ? "The reference price recorded in step 1 does not match a price bin of the pool this page creates, so the pool cannot be created here."
                      : (missingProof ?? (balances.error ? `Your balances could not be read: ${balances.error}` : "Reading your balances…")))
            }
            signs={[
              `creates a ${ticker} / USDC Meteora DLMM pool at the starting price, with trading opening about ${formatSlots(BigInt(ACTIVATION_DELAY_SLOTS), SLOT_MS).replace("~", "")} later`,
              "records that pool in the launch, once and permanently (set_pool)",
            ]}
            costs={[
              ["Starting price", startPrice !== null ? `${formatPrice(startPrice)} per token` : "n/a", "the price bin recorded by step 1"],
              [
                "Trading opens",
                `${ACTIVATION_DELAY_SLOTS.toLocaleString("en-US")} slots after creation (${formatSlots(BigInt(ACTIVATION_DELAY_SLOTS), SLOT_MS)})`,
                "step 3 has to be confirmed inside this window; it cannot be extended",
              ],
              ["Tokens / USDC", "none spent", "your wallet must hold some of both: Meteora checks it, and takes nothing"],
              ["SOL", "rent for the pool's accounts + network fee", "exact amount is simulated before you sign"],
            ]}
            onReview={reviewPool}
          >
            {launch && !launch.pool && balances.data && (
              <p className={`small ${missingProof ? "bad" : "muted"}`}>
                Your wallet holds {formatUsd(balances.data.usdc)} USDC and {tokens(balances.data.token)}.{" "}
                {missingProof ? "" : "That satisfies Meteora's check; no USDC is deposited in any step."}
              </p>
            )}
          </Step>
          <Step
            index="3"
            title="Seed the pool with tokens only, locked in the vault"
            status={
              seedDone
                ? "done"
                : publicKey &&
                    isCreator &&
                    !missedActivation &&
                    activation &&
                    !activation.open &&
                    seedSession &&
                    seedPlan.data &&
                    seedPlan.data.transactions.length > 0 &&
                    balances.data &&
                    !shortOfTokens &&
                    !tooLate
                  ? "ready"
                  : "blocked"
            }
            blocked={
              !launch?.pool
                ? "Complete step 2 first."
                : needWallet ??
                  market.error ??
                  lock.error ??
                  (!market.data || !lockData
                    ? "Loading the pool…"
                    : missedActivation
                      ? "The pool is open for trading and the vault owns no liquidity in it. It can no longer be seeded as locked."
                      : !isCreator
                        ? "Only the launch creator's wallet can seed the pool: it holds the tokens."
                        : !market.data.tokenIsX
                          ? "The launched token is not this pool's base token, so the pool cannot be seeded from this page."
                          : seedLost
                            ? "This browser session does not have the key the existing positions were created with, so the seeding cannot be continued from here."
                            : !multipleOk
                              ? `Choose a price range between ${MIN_RANGE_MULTIPLE}x and ${MAX_RANGE_MULTIPLE}x above.`
                              : (seedPlan.error ??
                                (!seedPlan.data || !balances.data
                                  ? "Preparing the seeding transactions…"
                                  : seedPlan.data.transactions.length === 0
                                    ? "Every seeding transaction is confirmed. Waiting for the chain to show the deposits…"
                                    : shortOfTokens && seedNeeds !== null
                                      ? `Your wallet holds ${tokens(balances.data.token)}; the rest of the seeding needs ${tokens(seedNeeds)} (what the pool still lacks plus the transfer tax on it).`
                                      : tooLate
                                        ? "Too little time is left before trading opens to confirm the remaining transactions."
                                        : undefined)))
            }
            intro={
              seedTotal !== null
                ? `You will sign ${remainingTxs ?? seedTotal} transaction${(remainingTxs ?? seedTotal) === 1 ? "" : "s"}, reviewed together and approved in one go if your wallet can sign several at once. They:`
                : "You will sign several transactions, reviewed together. They:"
            }
            action={
              remainingTxs !== null && seedTotal !== null && remainingTxs < seedTotal
                ? `Review the remaining ${remainingTxs} of ${seedTotal} transactions`
                : `Review ${seedTotal ?? "the"} transactions`
            }
            signs={[
              "send one token atom to the vault, which Meteora requires of a position's owner",
              `create ${range ? range.positions : "the"} liquidity position${range?.positions === 1 ? "" : "s"} owned by the vault, with a lock that never releases, and the price-bin accounts under them`,
              "deposit the pool allocation into them as tokens only: no USDC",
            ]}
            costs={[
              ["Tokens to the pool", poolAllocation !== null ? tokens(poolAllocation) : "n/a", "locked for good; you cannot take them back"],
              [
                "Transfer tax on that deposit",
                seedTax !== null ? tokens(seedTax) : "n/a",
                "leaves your wallet on top; withheld in the pool's account, then swept to the vault and sold by the keeper over time",
              ],
              ["USDC", "none"],
              [
                "Price range",
                range ? `${formatPrice(range.startPrice)} to ${formatPrice(range.topPrice)} per token` : "n/a",
                range ? `${range.binCount} bins of ${formatBps(BIN_STEP_BPS)}; more of the tokens sit near the top` : undefined,
              ],
              [
                "Transactions",
                seedTotal !== null
                  ? `${seedTotal}: 1 proof + ${(seedTotal - 1) / 2} to create positions + ${(seedTotal - 1) / 2} deposits`
                  : "n/a",
                "sent one after another, each after the one before has confirmed",
              ],
              ...(seedSent !== null && seedTotal !== null && launch?.pool
                ? ([["Progress", `${seedSent} of ${seedTotal} confirmed`, "read from chain; a reload continues from here"]] as [string, ReactNode, string?][])
                : []),
              [
                "SOL",
                seedPlan.data
                  ? `about ${(Number(seedPlan.data.rentLamports) / LAMPORTS_PER_SOL).toFixed(3)} SOL of rent still to pay + network fees`
                  : "rent for the positions and price-bin accounts + network fees",
                "the Meteora SDK's estimate; not returned, because the positions are never closed",
              ],
              ...(activation
                ? ([
                    [
                      "Must be confirmed before",
                      activation.open ? "trading has already opened" : `trading opens at ${formatActivation(activation, SLOT_MS)}`,
                      "positions for the vault can only be created before the pool is active",
                    ],
                  ] as [string, ReactNode, string?][])
                : []),
            ]}
            onReview={reviewSeed}
          >
            {balances.data && seedNeeds !== null && launch?.pool && !seedDone && (
              <p className={`small ${shortOfTokens ? "bad" : "muted"}`}>
                Your wallet holds {tokens(balances.data.token)}; the rest of the seeding takes up to {tokens(seedNeeds)}.
              </p>
            )}
            {!seedStored && (
              <p className="warn small">
                Your browser refused to store the key this step signs with. Do not reload or close this page until
                the step is done.
              </p>
            )}
          </Step>
          <Step
            index="4"
            title="Register the vault's Phoenix trader"
            status={launch?.traderAccount ? "done" : launch && publicKey ? "ready" : "blocked"}
            blocked={!launch ? "Complete step 1 first." : needWallet}
            signs={["creates the vault's own Phoenix perpetuals trader account (register_trader); any wallet can send this"]}
            costs={[
              ["Tokens / USDC", "none"],
              ["SOL", "rent for the trader account and one token account + network fee", "exact amount is simulated before you sign"],
            ]}
            onReview={reviewTrader}
          />
        </ol>
        <Notice title="After step 4: Phoenix onboarding">
          <p>
            After <code>register_trader</code>, Phoenix must enable the vault&apos;s trader account through its API.
            That is done with <code>scripts/onboard-trader.ts</code>, not from this page. Until then deployment cannot
            happen: no collateral is deposited and no {assetSymbol ? `${assetSymbol} ` : ""}perp exposure is opened. Tax collection, conversion and
            redemptions against the vault&apos;s idle USDC work in the meantime.
          </p>
          <p className="small">
            After that the Terp keeper, the launchpad operator&apos;s key, sweeps the tax, sells it and deploys it,
            usually in one transaction. The keeper decides when; the program fixes the batch size, the price floor, the
            order, the keeper fee and where the money goes, and the keeper cannot withdraw anything. Collecting tax, deleveraging,
            redemptions and claim payouts stay open to any wallet and do not depend on the keeper.
          </p>
        </Notice>
      </Panel>
    </>
  );
}
