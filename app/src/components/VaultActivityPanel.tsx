"use client";

import { TOKEN_2022_PROGRAM_ID, getTransferFeeAmount, unpackAccount } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  DLMM_PROGRAM_ID,
  SLOT_MS,
  USDC_DECIMALS,
  USDC_MINT,
  launchAddresses,
  math,
  type VaultState,
} from "@terp/sdk";
import BN from "bn.js";
import { useState, type ReactNode } from "react";
import { useAsync, type AsyncState } from "@/hooks/useAsync";
import { useClient, useProtocol } from "@/hooks/useClient";
import { PHOENIX_COMPUTE_UNITS, useSendTx } from "@/hooks/useSendTx";
import type { Market } from "@/lib/chain";
import { errorMessage } from "@/lib/errors";
import { formatAtoms, formatBps, formatLeverage, formatPrice, formatSlots, formatUsd } from "@/lib/format";
import { Address, Notice, Panel, Rows } from "./ui";

/** Anchor of this panel, for links elsewhere on the page. */
export const ACTIVITY_ANCHOR = "vault-activity";

/** Tolerance given to the pool swap itself. The price floor that matters is enforced by the program. */
const CONVERT_SLIPPAGE_BPS = 100;

/**
 * Token accounts swept by the keeper's one-transaction action. Each is an extra account in a
 * transaction that also carries the pool swap and the Phoenix accounts, so it is kept small;
 * "Collect tax" on its own sweeps more.
 */
const COMBINED_COLLECT_SOURCES = 6;

interface Props {
  state: VaultState;
  symbol: string;
  market: AsyncState<Market>;
  onDone: () => void;
}

function Work(props: {
  title: string;
  badge: string;
  good?: boolean;
  /** Why it cannot be sent now, or what sending it would do. */
  status: ReactNode;
  /** Absent when the connected wallet may not send this step. */
  action?: { label: string; enabled: boolean; onClick: () => void };
}) {
  return (
    <li>
      <div>
        <strong>{props.title}</strong>
        <span className={`badge ${props.good ? "good" : ""}`}>{props.badge}</span>
      </div>
      <span className="small">{props.status}</span>
      {props.action && (
        <div>
          <button
            className={props.action.enabled ? "primary" : ""}
            disabled={!props.action.enabled}
            onClick={props.action.onClick}
          >
            {props.action.label}
          </button>
        </div>
      )}
    </li>
  );
}

export function VaultActivityPanel({ state, symbol, market, onDone }: Props) {
  const client = useClient();
  const protocol = useProtocol();
  const sendTx = useSendTx();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { launch, perp } = state;
  const [collecting, setCollecting] = useState(false);
  const [collectNote, setCollectNote] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [combinedNote, setCombinedNote] = useState<string | null>(null);

  const config = protocol.status === "ready" ? protocol.config : null;
  const keeper = config?.keeper ?? null;
  // receives the keeper fee; a conversion cannot be built without it
  const treasury = config?.treasury ?? null;
  const paused = Boolean(config?.paused);
  const isKeeper = Boolean(publicKey && keeper && publicKey.equals(keeper));
  const work = client.pendingWork(state, paused);
  const tokens = (amount: bigint) => `${formatAtoms(amount, launch.decimals)} ${symbol}`;
  /** A program price (USDC atoms per token atom × 1e12) as USDC per whole token. */
  const perToken = (price: bigint) =>
    formatPrice((Number(price) / Number(math.PRICE_SCALE)) * 10 ** (launch.decimals - USDC_DECIMALS));
  const leverageText = (bps: bigint | null) => (bps === null ? "n/a (no equity)" : formatLeverage(bps));
  const target = formatLeverage(launch.targetLeverageBps);
  const min = formatLeverage(launch.minLeverageBps);
  const max = formatLeverage(launch.maxLeverageBps);
  const deleverageTo = formatLeverage(launch.deleverageToBps);
  const keeperFeeRate = formatBps(launch.keeperFeeBps);
  /** The platform's share of what the pool pays for a tax batch; the vault gets the rest. */
  const keeperFeeOf = (usdcOut: bigint) => math.bpsOf(usdcOut, launch.keeperFeeBps);

  /** The pool's quote for selling `amount` of tax, as the vault's tax authority would get it. */
  const quoteBatch = async (amount: bigint) => {
    const { dlmm, tokenIsX } = market.data!;
    // "swap for Y" means selling the pool's X token; the tax batch sells the launch token
    const binArrays = await dlmm.getBinArrayForSwap(tokenIsX);
    const quote = dlmm.swapQuote(new BN(amount.toString()), tokenIsX, new BN(CONVERT_SLIPPAGE_BPS), binArrays);
    return { quote, out: BigInt(quote.outAmount.toString()) };
  };
  type BatchQuote = Awaited<ReturnType<typeof quoteBatch>>;

  // Pool quote for the batch the program would sell from tax already collected.
  const batch = work.convertBatch;
  const convertQuote = useAsync(
    () => quoteBatch(batch),
    market.data && batch > 0n ? `convert:${launch.address.toBase58()}:${batch}` : null,
    10_000,
  );
  const quoted = convertQuote.data;
  const elapsed = state.slot > launch.lastConvertSlot ? state.slot - launch.lastConvertSlot : 0n;
  const floor = math.conversionPriceFloor(launch.emaPrice, launch.maxPriceDropBps, elapsed, launch.convertCooldownSlots);
  const quotedPrice = quoted && batch > 0n ? math.conversionPrice(quoted.out, batch) : null;
  const belowFloor = quotedPrice !== null && quotedPrice < floor;
  const cooldownLeft =
    work.convertBlockedBy === "cooldown" ? launch.convertCooldownSlots - (state.slot - launch.lastConvertSlot) : 0n;
  const onboarded = Boolean(state.trader?.isOnboarded);

  // The policy: what the next deployment does with the USDC idle in the vault right now.
  const leverageAfterDeposit = math.leverageBps(perp.notional, perp.equity + work.deployUsdc);
  const hasPosition = perp.notional !== 0n;
  // exposure is added when leverage after the deposit is under the launch minimum; profit or loss plays no part
  const leveragePosition = !hasPosition
    ? `no position; with collateral, the next deployment opens one at ${target}`
    : perp.isLiquidatable || state.leverageBps === null
      ? "the account is liquidatable"
      : state.leverageBps > BigInt(launch.maxLeverageBps)
        ? `above the ${max} deleverage threshold; any wallet can cut the position to ${deleverageTo}`
        : state.leverageBps > BigInt(launch.targetLeverageBps)
          ? `above the ${target} target; tax adds collateral only, and nothing is cut unless it goes above ${max}`
          : state.leverageBps >= BigInt(launch.minLeverageBps)
            ? `between the ${min} minimum and the ${target} target; nothing is traded`
            : `under the ${min} minimum; the next deployment tops the position up to ${target}`;
  /** Shown for information only: the policy acts on leverage, not on profit or loss. */
  const pnlText = hasPosition ? formatUsd(perp.unrealizedPnl) : "no position";
  /** The "Adds exposure" line of a deploy review. */
  const exposureText = (wouldIncrease: boolean) =>
    wouldIncrease
      ? hasPosition
        ? `yes, leverage after the deposit is under ${min}: tops the position up to ${target}`
        : `yes, opens the position at ${target}`
      : hasPosition
        ? `no, leverage after the deposit is not under ${min}: collateral only`
        : "no";
  const nextDeployment = paused
    ? "none while the protocol is paused"
    : !launch.traderAccount
      ? "none until the vault's Phoenix trader account is registered"
      : !onboarded
        ? "none until Phoenix enables the vault's trader account"
        : perp.isLiquidatable
          ? "none while the account is liquidatable"
          : work.wouldIncrease
            ? !hasPosition
              ? work.deployUsdc > 0n
                ? `adds ${formatUsd(work.deployUsdc)} of collateral and opens the position at ${target}`
                : `opens the position at ${target} on the collateral already deposited`
              : work.deployUsdc > 0n
                ? `adds collateral and tops the position up to ${target}: leverage ${leverageText(state.leverageBps)} → ${leverageText(leverageAfterDeposit)} after the ${formatUsd(work.deployUsdc)} deposit, then back up to ${target}`
                : `tops the position up to ${target}: leverage ${leverageText(state.leverageBps)} is under the ${min} minimum; no new collateral`
            : work.deployUsdc > 0n
              ? `adds collateral only: leverage ${leverageText(state.leverageBps)} → ${leverageText(leverageAfterDeposit)} (${formatUsd(work.deployUsdc)} deposited; that is not under the ${min} minimum, so no exposure is added)`
              : `nothing yet: idle USDC (${formatUsd(state.freeUsdc)}) is under the ${formatUsd(launch.minDepositUsdc)} minimum deposit and leverage is not under the ${min} minimum, so nothing is topped up`;

  /** The pool swap for one tax batch, wrapped in the keeper's `convert_tax`, which pays the keeper fee to `treasuryKey`. */
  const convertIx = async (keeperKey: PublicKey, treasuryKey: PublicKey, amount: bigint, { quote }: BatchQuote) => {
    const { dlmm } = market.data!;
    const transaction = await dlmm.swap({
      inToken: launch.mint,
      outToken: USDC_MINT,
      inAmount: new BN(amount.toString()),
      minOutAmount: quote.minOutAmount,
      lbPair: dlmm.pubkey,
      user: launchAddresses(launch.mint, client.programId).taxAuthority,
      binArraysPubkey: quote.binArraysPubkey,
    });
    const swaps = transaction.instructions.filter((ix) => ix.programId.equals(DLMM_PROGRAM_ID));
    if (swaps.length !== 1) throw new Error(`Expected one Meteora DLMM swap instruction, found ${swaps.length}.`);
    return client.convertTaxIx(keeperKey, launch, amount, swaps[0], treasuryKey);
  };

  const collect = async () => {
    if (!publicKey) return;
    setCollecting(true);
    setCollectNote(null);
    try {
      const sources = await client.findWithheldAccounts(launch.mint);
      if (sources.length === 0 && state.withheldOnMint === 0n) {
        setCollectNote("No withheld fee tokens were found on this mint or its token accounts. Nothing to collect right now.");
        return;
      }
      const signature = await sendTx({
        title: `Collect withheld ${symbol} tax`,
        rows: [
          ["Token accounts swept", `${sources.length}`],
          ["Withheld on the mint itself", tokens(state.withheldOnMint)],
          ["Destination", `the vault's tax account (${launch.taxAccount.toBase58()})`],
        ],
        notes: [
          `Moves withheld ${formatBps(launch.transferFeeBps)} transfer-tax tokens into the vault's tax account. Any wallet can send this; the destination is fixed by the program. You receive nothing and pay only the network fee.`,
        ],
        build: async () => ({ instructions: [await client.collectTaxIx(publicKey, launch, sources)] }),
      });
      if (signature) onDone();
    } catch (error) {
      setCollectNote(errorMessage(error));
    } finally {
      setCollecting(false);
    }
  };

  const convert = async () => {
    if (!publicKey || !isKeeper || !treasury || !market.data || !quoted || batch === 0n) return;
    const fee = keeperFeeOf(quoted.out);
    const signature = await sendTx({
      title: `Convert ${symbol} tax to USDC`,
      rows: [
        ["Tax tokens sold", tokens(batch)],
        ["Pool quote", formatUsd(quoted.out, 6)],
        [`Keeper fee to the platform (${keeperFeeRate})`, formatUsd(fee, 6)],
        ["To the vault", formatUsd(quoted.out - fee, 6)],
        ["Platform treasury", treasury.toBase58()],
        ["Lowest price the program accepts", `${perToken(floor)} per token`],
        ["Pool", market.data.dlmm.pubkey.toBase58()],
      ],
      notes: [
        `Keeper only. The swap is signed by the program for the vault's tax authority, not by your wallet. Of the USDC the pool pays, the program sends ${keeperFeeRate} to the platform treasury as the keeper fee and the rest to the vault.`,
        "The program itself enforces the batch size and the price floor. If the pool pays less than the floor, the transaction fails and nothing is sold.",
      ],
      computeUnits: PHOENIX_COMPUTE_UNITS,
      build: async () => ({ instructions: [await convertIx(publicKey, treasury, batch, quoted)] }),
    });
    if (signature) onDone();
  };

  const deploy = async () => {
    if (!publicKey || !isKeeper || !work.canDeploy) return;
    const signature = await sendTx({
      title: "Deploy idle USDC",
      rows: [
        ["Deposited as Phoenix collateral", formatUsd(work.deployUsdc, 6)],
        ["Leverage now", leverageText(state.leverageBps)],
        ["Leverage after the deposit", leverageText(leverageAfterDeposit)],
        ["Adds exposure", exposureText(work.wouldIncrease)],
      ],
      notes: [
        `Keeper only. The program deposits all idle USDC not reserved for claims as collateral. If there is then no position, or leverage is under ${min}, it buys ${launch.symbol} perp at Phoenix's mark to bring leverage up to ${target}, never above, whether the position is in profit or not. At ${min} or above it adds no exposure.`,
        "You decide nothing about size, price or destination, and receive nothing.",
      ],
      computeUnits: PHOENIX_COMPUTE_UNITS,
      build: async () => ({ instructions: [await client.deployIx(publicKey, launch)] }),
    });
    if (signature) onDone();
  };

  /**
   * The keeper's usual transaction: collect, convert and deploy together. Works out what the vault
   * will hold after each step, and explains instead of sending when one of the three cannot run.
   */
  const collectConvertDeploy = async () => {
    if (!publicKey || !isKeeper || !treasury) return;
    setPreparing(true);
    setCombinedNote(null);
    try {
      if (paused) return setCombinedNote("Not possible now: the protocol is paused, so conversion and deployment are refused.");
      if (!launch.pool || !market.data) {
        return setCombinedNote(
          launch.pool
            ? `Convert is not possible now: the pool could not be read${market.error ? ` (${market.error})` : ""}.`
            : "Convert is not possible now: the launch has no pool yet, so there is nowhere to sell tax.",
        );
      }

      // Collect: what the sweep would add to the tax account.
      const sources = await client.findWithheldAccounts(launch.mint, COMBINED_COLLECT_SOURCES);
      const infos = sources.length ? await connection.getMultipleAccountsInfo(sources, "confirmed") : [];
      let withheld = state.withheldOnMint;
      sources.forEach((source, index) => {
        const info = infos[index];
        if (info) withheld += getTransferFeeAmount(unpackAccount(source, info, TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
      });
      if (withheld === 0n) {
        return setCombinedNote(
          "Collect is not possible now: no withheld fee tokens were found on this mint or its token accounts. Use Convert tax and Deploy below for what is already in the vault.",
        );
      }

      // Convert: the batch the program will compute once the sweep has landed.
      const collected = { ...state, taxTokens: state.taxTokens + withheld, withheldOnMint: 0n };
      const afterCollect = client.pendingWork(collected, paused);
      if (afterCollect.convertBatch === 0n) {
        return setCombinedNote(
          afterCollect.convertBlockedBy === "cooldown"
            ? `Convert is not possible now: the cooldown has ${cooldownLeft} slots left (${formatSlots(cooldownLeft, SLOT_MS)}). Collect tax on its own still works.`
            : `Convert is not possible now: after collecting, the vault would hold ${tokens(collected.taxTokens)} of tax and a batch needs at least ${tokens(launch.minConvertTokens)}. Collect tax on its own still works.`,
        );
      }
      const amount = afterCollect.convertBatch;
      const batchQuote = await quoteBatch(amount);
      const price = math.conversionPrice(batchQuote.out, amount);
      if (price < floor) {
        return setCombinedNote(
          `Convert is not possible now: the pool quotes ${perToken(price)} per token for the batch, below the program's floor of ${perToken(floor)}. Collect tax on its own still works.`,
        );
      }

      // Deploy: what the program would do with the vault's USDC once the conversion has landed.
      const fee = keeperFeeOf(batchQuote.out);
      const toVault = batchQuote.out - fee;
      const converted = {
        ...collected,
        idleUsdc: state.idleUsdc + toVault,
        freeUsdc: state.freeUsdc + toVault,
      };
      const afterConvert = client.pendingWork(converted, paused);
      if (!afterConvert.canDeploy || state.markIsStale) {
        const why = !launch.traderAccount
          ? "the vault's Phoenix trader account is not registered yet"
          : !onboarded
            ? "Phoenix has not enabled the vault's trader account yet"
            : state.markIsStale
              ? "the Phoenix mark price is stale"
              : perp.isLiquidatable
                ? "the Phoenix account is liquidatable"
                : `the vault would hold ${formatUsd(converted.freeUsdc)} of idle USDC, under the ${formatUsd(launch.minDepositUsdc)} minimum deposit, and there is nothing to top up`;
        return setCombinedNote(`Deploy is not possible now: ${why}. Collect tax and Convert tax still work on their own.`);
      }
      const leverageAfter = math.leverageBps(perp.notional, perp.equity + afterConvert.deployUsdc);

      const signature = await sendTx({
        title: `Collect, convert and deploy ${symbol} tax`,
        rows: [
          ["1. Collected into the vault's tax account", `${tokens(withheld)} from the mint and ${sources.length} token accounts`],
          ["2. Tax tokens sold", tokens(amount)],
          ["Pool quote", formatUsd(batchQuote.out, 6)],
          [`Keeper fee to the platform (${keeperFeeRate})`, formatUsd(fee, 6)],
          ["To the vault", formatUsd(toVault, 6)],
          ["Lowest price the program accepts", `${perToken(floor)} per token`],
          ["3. Deposited as Phoenix collateral", `about ${formatUsd(afterConvert.deployUsdc, 6)}`],
          ["Leverage now → after the deposit", `${leverageText(state.leverageBps)} → ${leverageText(leverageAfter)}`],
          ["Adds exposure", exposureText(afterConvert.wouldIncrease)],
        ],
        notes: [
          "Keeper only. One transaction: collect_tax, convert_tax and deploy, in that order. If any of the three fails, none of them happens.",
          `The program computes the batch, enforces the price floor, pays the ${keeperFeeRate} keeper fee to the platform treasury, sends the rest of the USDC to the vault and then to the vault's own Phoenix account, and sizes and prices any order. Your wallet receives nothing.`,
        ],
        computeUnits: PHOENIX_COMPUTE_UNITS,
        build: async () => ({
          instructions: [
            await client.collectTaxIx(publicKey, launch, sources),
            await convertIx(publicKey, treasury, amount, batchQuote),
            await client.deployIx(publicKey, launch),
          ],
        }),
      });
      if (signature) onDone();
    } catch (error) {
      setCombinedNote(errorMessage(error));
    } finally {
      setPreparing(false);
    }
  };

  const venueAction = async (
    title: string,
    rows: [string, string][],
    note: string,
    build: () => Promise<{ instructions: TransactionInstruction[] }>,
    computeUnits?: number,
  ) => {
    const signature = await sendTx({ title, rows, notes: [note], computeUnits, build });
    if (signature) onDone();
  };

  const convertStatus: ReactNode =
    paused
      ? "The protocol is paused; conversions are refused."
      : work.convertBlockedBy === "no-pool"
        ? "The launch has no pool yet, so there is nowhere to sell tax."
        : work.convertBlockedBy === "below-threshold"
          ? `Collected tax is ${tokens(state.taxTokens)}; a batch needs at least ${tokens(launch.minConvertTokens)}.`
          : work.convertBlockedBy === "cooldown"
            ? `Cooldown: the next conversion is allowed in ${cooldownLeft} slots (${formatSlots(cooldownLeft, SLOT_MS)}).`
            : market.error && !market.data
              ? `The pool could not be read: ${market.error}`
              : convertQuote.error
                ? `No pool quote: ${convertQuote.error}`
                : !quoted
                  ? "Fetching the pool quote…"
                  : (
                      <>
                        Next batch: {tokens(batch)}. The pool quotes {formatUsd(quoted.out, 6)} for it
                        {quotedPrice !== null && <> ({perToken(quotedPrice)} per token)</>}:{" "}
                        {formatUsd(keeperFeeOf(quoted.out), 6)} ({keeperFeeRate}) is the platform&apos;s keeper fee and{" "}
                        {formatUsd(quoted.out - keeperFeeOf(quoted.out), 6)} goes to the vault. The program itself enforces the batch size and the price floor ({perToken(floor)} per
                        token now), so the keeper cannot sell the batch cheaply.
                        {belowFloor && (
                          <strong className="warn"> The current quote is below that floor: the program would refuse this sale.</strong>
                        )}
                      </>
                    );

  const deployStatus = paused
    ? "The protocol is paused; deployment is refused."
    : !launch.traderAccount
      ? "The vault's Phoenix trader account is not registered yet."
      : !onboarded
        ? "Phoenix has not enabled the vault's trader account yet, so deploy cannot work."
        : state.markIsStale
          ? "The Phoenix mark price is stale; deployment is refused until it updates."
          : `Next deployment ${nextDeployment}.`;

  const needWallet = !publicKey;
  const convertReady = batch > 0n && !!quoted && !belowFloor && !!treasury;
  const deployReady = work.canDeploy && !state.markIsStale;
  const keeperPending = batch > 0n || work.canDeploy;
  /** Badge of a keeper-only step: the keeper sees whether it can send, everyone else whether it is waiting. */
  const keeperBadge = (ready: boolean, pending: boolean) =>
    isKeeper ? (ready ? "Can be sent now" : "Not possible now") : pending ? "Waiting for the keeper" : "Nothing to do now";

  return (
    <Panel id={ACTIVITY_ANCHOR} title="Vault activity" aside="run by the Terp keeper">
      <p className="muted small">
        The Terp keeper, the launchpad operator&apos;s key, sweeps the withheld tax, sells it in the pool and deploys the
        USDC, usually all in one transaction. The keeper decides <strong>when</strong>; the program fixes the batch
        size, the price floor, the {keeperFeeRate} keeper fee, the order&apos;s size and price, and where the money goes. The keeper cannot withdraw
        anything or redirect funds. If it is offline, tax simply waits: collecting tax, redemptions, deleveraging and
        claim payouts do not depend on it and stay open to any wallet.
      </p>

      <Rows
        rows={[
          [
            "Terp keeper",
            keeper ? <Address key="keeper" value={keeper} full /> : "unknown",
            "the only key that can convert tax and deploy it; it cannot withdraw",
          ],
          [
            "Keeper fee",
            `${keeperFeeRate} of each conversion`,
            "of the USDC the pool pays, to the Terp platform treasury; the rest goes to the vault; fixed for this launch",
          ],
          [
            "Keeper work",
            paused
              ? "paused by the protocol admin"
              : keeperPending
                ? isKeeper
                  ? "pending: you are connected as the keeper"
                  : "pending: waiting for the keeper"
                : "nothing pending",
            "tax ready to convert, or USDC ready to deploy",
          ],
          [
            "Collected tax waiting to be sold",
            `${tokens(state.taxTokens)} of ${tokens(launch.minConvertTokens)} needed`,
            `one batch sells at most ${tokens(launch.maxConvertTokens)}`,
          ],
          [
            "Withheld on the mint, not collected yet",
            tokens(state.withheldOnMint),
            "more may be withheld in individual token accounts; Collect tax finds those",
          ],
          [
            "Conversion cooldown",
            work.convertBlockedBy === "cooldown"
              ? `${cooldownLeft} slots left (${formatSlots(cooldownLeft, SLOT_MS)})`
              : launch.tokensConverted === 0n
                ? "none yet (no conversion so far)"
                : "elapsed",
            `${launch.convertCooldownSlots} slots between conversions`,
          ],
          [
            "Idle USDC available to deploy",
            `${formatUsd(state.freeUsdc)} of ${formatUsd(launch.minDepositUsdc)} needed`,
            "idle USDC less outstanding claims",
          ],
          ["Arrived collateral to unwrap", formatUsd(work.canonicalToUnwrap, 6), "Phoenix canonical USDC held by the vault"],
          [
            "Claims shortfall",
            formatUsd(work.claimsShortfall, 6),
            state.trader?.hasQueuedWithdrawal
              ? "a Phoenix withdrawal is already queued"
              : "claims not covered by USDC the vault holds",
          ],
        ]}
      />

      <h3 className="label" style={{ marginTop: 16 }}>
        Leverage policy
      </h3>
      <Rows
        rows={[
          ["Leverage now", leverageText(state.leverageBps), leveragePosition],
          ["Target", target, "what the vault aims to hold; exposure is only ever added up to this"],
          ["Minimum", min, `under this after a deposit, a deployment buys exposure back up to ${target}, in profit or not`],
          ["Deleverage threshold", max, `above this any wallet can cut the position to ${deleverageTo}`],
          ["Position PnL", pnlText, "for information; the policy acts on leverage, not on profit or loss"],
          ["Next deployment", nextDeployment, "from the USDC idle in the vault now; tax not yet converted adds to it"],
        ]}
      />
      <p className="muted small">
        The vault aims to keep its position open and close to {target}. Each deployment first adds the new USDC as
        collateral, which lowers leverage and moves the liquidation price further away. If leverage is then under{" "}
        {min}, the deployment buys exposure back up to {target}, with or without new tax and whether the position is
        in profit or not, so gains are compounded into a larger position. Between {min} and {target} nothing is
        traded, which avoids paying taker fees for small drifts. Between {target} and {max}, usually after{" "}
        {launch.symbol} fell, tax is collateral only and pulls leverage back down. Above {max} any wallet can cut the
        position to {deleverageTo}. The same rule opens the first position and re-opens one that was closed or
        liquidated.
      </p>

      {needWallet && <Notice><p>Connect a wallet to send the steps that are open to any wallet.</p></Notice>}

      <ul className="events work">
        {isKeeper && (
          <Work
            title="Collect, convert and deploy"
            badge="Checked when you click"
            status={
              combinedNote ??
              `The keeper's usual transaction: sweeps withheld tax (the mint and up to ${COMBINED_COLLECT_SOURCES} token accounts), sells the batch and deploys the USDC, all three in one transaction. If one of them is not possible right now, nothing is sent and this line says which.`
            }
            action={{
              label: preparing ? "Checking each step…" : "Collect, convert and deploy",
              enabled: !preparing,
              onClick: collectConvertDeploy,
            }}
          />
        )}
        <Work
          title="Collect tax"
          badge={needWallet ? "Any wallet" : "Checked when you click"}
          status={
            collectNote ??
            `Sweeps withheld ${formatBps(launch.transferFeeBps)} transfer-tax tokens from the mint and from token accounts into the vault's tax account. Open to any wallet; it is what makes a conversion possible.`
          }
          action={{
            label: collecting ? "Finding withheld fees…" : "Collect tax",
            enabled: !needWallet && !collecting,
            onClick: collect,
          }}
        />
        <Work
          title="Convert tax"
          badge={keeperBadge(convertReady, batch > 0n)}
          good={isKeeper && convertReady}
          status={
            <>
              {convertStatus}
              {!isKeeper && batch > 0n && " Waiting for the keeper to send it; there is nothing to click."}
            </>
          }
          action={isKeeper ? { label: "Convert tax", enabled: convertReady, onClick: convert } : undefined}
        />
        <Work
          title="Deploy"
          badge={keeperBadge(deployReady, work.canDeploy)}
          good={isKeeper && deployReady}
          status={
            <>
              {deployStatus}
              {!isKeeper && work.canDeploy && " Waiting for the keeper to send it; there is nothing to click."}
            </>
          }
          action={isKeeper ? { label: "Deploy", enabled: deployReady, onClick: deploy } : undefined}
        />
        <Work
          title="Deleverage"
          badge={work.canDeleverage ? "Can be sent now" : "Not possible now"}
          good={work.canDeleverage}
          status={
            work.canDeleverage
              ? `Leverage is above ${max} or the account is liquidatable. Cuts the position to ${deleverageTo}, not all the way to ${target}, so less of the loss is realised. Open to any wallet.`
              : `Only possible when leverage is above ${max} or the account is liquidatable. Open to any wallet.`
          }
          action={{
            label: "Deleverage",
            enabled: !needWallet && work.canDeleverage,
            onClick: () =>
              venueAction(
                "Deleverage the vault",
                [
                  ["Leverage now", leverageText(state.leverageBps)],
                  ["Cuts the position to", deleverageTo],
                ],
                `The program closes exactly the part of the position that brings leverage down to ${deleverageTo}, at Phoenix's mark, and realises the loss on that part. Nothing is withdrawn and you receive nothing; you pay the network fee.`,
                async () => ({ instructions: [await client.deleverageIx(publicKey!, launch)] }),
                PHOENIX_COMPUTE_UNITS,
              ),
          }}
        />
        <Work
          title="Unwrap"
          badge={work.canonicalToUnwrap > 0n ? "Can be sent now" : "Not possible now"}
          good={work.canonicalToUnwrap > 0n}
          status="Converts collateral tokens that arrived from Phoenix into USDC in the vault. Open to any wallet."
          action={{
            label: "Unwrap",
            enabled: !needWallet && work.canonicalToUnwrap > 0n,
            onClick: () =>
              venueAction(
                "Unwrap arrived collateral",
                [["Converted to idle USDC", formatUsd(work.canonicalToUnwrap, 6)]],
                "Converts the vault's Phoenix canonical USDC into USDC in the vault, where it pays claims and redemptions. You pay the network fee.",
                async () => ({ instructions: [await client.unwrapCanonicalIx(publicKey!, launch)] }),
              ),
          }}
        />
        <Work
          title="Fund claims"
          badge={work.claimsShortfall > 0n ? "Can be sent now" : "Not possible now"}
          good={work.claimsShortfall > 0n}
          status={
            state.trader?.hasQueuedWithdrawal
              ? "A Phoenix withdrawal is already queued for this vault; nothing to re-request until it arrives."
              : "Re-requests from Phoenix the USDC that outstanding claims are still short of, if a queued withdrawal was dropped. Open to any wallet."
          }
          action={{
            label: "Fund claims",
            enabled: !needWallet && work.claimsShortfall > 0n,
            onClick: () =>
              venueAction(
                "Fund outstanding claims",
                [
                  ["Outstanding claims", formatUsd(launch.pendingClaims, 6)],
                  ["Requested from Phoenix", formatUsd(work.claimsShortfall, 6)],
                ],
                "Asks Phoenix again for the USDC that claims are short of. The money stays in the vault and can only be paid to claim owners. You pay the network fee.",
                async () => ({ instructions: [await client.fundClaimsIx(publicKey!, launch)] }),
                PHOENIX_COMPUTE_UNITS,
              ),
          }}
        />
      </ul>
      <p className="muted small">
        Figures are estimates from the current pool quote and vault balances; the program moves what the transaction
        actually produces. Each button opens a review that simulates the transaction first. Paying out a claim is in
        the redemption panel.
      </p>
    </Panel>
  );
}
