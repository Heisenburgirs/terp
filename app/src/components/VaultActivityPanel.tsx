"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import type { TransactionInstruction } from "@solana/web3.js";
import { SLOT_MS, USDC_DECIMALS, launchAddresses, math, type VaultState } from "@terp/sdk";
import BN from "bn.js";
import { useState, type ReactNode } from "react";
import { useAsync, type AsyncState } from "@/hooks/useAsync";
import { useClient, useProtocol } from "@/hooks/useClient";
import { PHOENIX_COMPUTE_UNITS, useSendTx } from "@/hooks/useSendTx";
import type { Market } from "@/lib/chain";
import { errorMessage } from "@/lib/errors";
import { formatAtoms, formatBps, formatLeverage, formatPrice, formatSlots, formatUsd } from "@/lib/format";
import { TAX_SWAP_SLIPPAGE_BPS, buildTaxSwap } from "@/lib/upkeep";
import { Notice, Panel, Rows } from "./ui";

/** Anchor of this panel, for links elsewhere on the page. */
export const ACTIVITY_ANCHOR = "vault-activity";

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
  action: { label: string; enabled: boolean; onClick: () => void };
}) {
  return (
    <li>
      <div>
        <strong>{props.title}</strong>
        <span className={`badge ${props.good ? "good" : ""}`}>{props.badge}</span>
      </div>
      <span className="small">{props.status}</span>
      <div>
        <button
          className={props.action.enabled ? "primary" : ""}
          disabled={!props.action.enabled}
          onClick={props.action.onClick}
        >
          {props.action.label}
        </button>
      </div>
    </li>
  );
}

export function VaultActivityPanel({ state, symbol, market, onDone }: Props) {
  const client = useClient();
  const protocol = useProtocol();
  const sendTx = useSendTx();
  const { publicKey } = useWallet();
  const { launch, perp } = state;
  const [collecting, setCollecting] = useState(false);
  const [collectNote, setCollectNote] = useState<string | null>(null);

  const config = protocol.status === "ready" ? protocol.config : null;
  // receives the platform fee; a tax sale cannot be built without it
  const treasury = config?.treasury ?? null;
  const paused = Boolean(config?.paused);
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
  const platformFeeRate = formatBps(launch.platformFeeBps);
  /** The platform's share of what the pool pays for a tax batch; the vault gets the rest. */
  const platformFeeOf = (usdcOut: bigint) => math.bpsOf(usdcOut, launch.platformFeeBps);

  // Pool quote for the batch the program would sell from tax already collected.
  const batch = work.convertBatch;
  const convertQuote = useAsync(
    async () => {
      const { dlmm, tokenIsX } = market.data!;
      // "swap for Y" means selling the pool's X token; the tax batch sells the launch token
      const binArrays = await dlmm.getBinArrayForSwap(tokenIsX);
      const quote = dlmm.swapQuote(new BN(batch.toString()), tokenIsX, new BN(TAX_SWAP_SLIPPAGE_BPS), binArrays);
      return { out: BigInt(quote.outAmount.toString()) };
    },
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

  // The policy: what the next rebalance does with the USDC idle in the vault right now.
  const leverageAfterDeposit = math.leverageBps(perp.notional, perp.equity + work.deployUsdc);
  const hasPosition = perp.notional !== 0n;
  // exposure is added when leverage after the deposit is under the launch minimum; profit or loss plays no part
  const leveragePosition = !hasPosition
    ? `no position; with collateral, the next rebalance opens one at ${target}`
    : perp.isLiquidatable || state.leverageBps === null
      ? "the account is liquidatable"
      : state.leverageBps > BigInt(launch.maxLeverageBps)
        ? `above the ${max} threshold; the next rebalance cuts the position to ${deleverageTo}`
        : state.leverageBps > BigInt(launch.targetLeverageBps)
          ? `above the ${target} target; tax adds collateral only, and nothing is cut unless it goes above ${max}`
          : state.leverageBps >= BigInt(launch.minLeverageBps)
            ? `between the ${min} minimum and the ${target} target; nothing is traded`
            : `under the ${min} minimum; the next rebalance tops the position up to ${target}`;
  /** Shown for information only: the policy acts on leverage, not on profit or loss. */
  const pnlText = hasPosition ? formatUsd(perp.unrealizedPnl) : "no position";
  /** The "Adds exposure" line of a rebalance review. */
  const exposureText = (wouldIncrease: boolean) =>
    wouldIncrease
      ? hasPosition
        ? `yes, leverage after the deposit is under ${min}: tops the position up to ${target}`
        : `yes, opens the position at ${target}`
      : hasPosition
        ? `no, leverage after the deposit is not under ${min}: collateral only`
        : "no";
  const nextRebalance = !launch.traderAccount
    ? "nothing until the vault's Phoenix trader account is registered"
    : !onboarded
      ? "nothing until Phoenix enables the vault's trader account"
      : work.canDeleverage
        ? state.markIsStale
          ? `nothing while the Phoenix mark price is stale; once it updates, cuts the position to ${deleverageTo}`
          : `cuts the position to ${deleverageTo}: leverage ${leverageText(state.leverageBps)} is above ${max}, or the account is liquidatable`
        : paused
          ? "nothing while the protocol is paused (a pause stops deposits and new exposure, never a cut)"
          : perp.isLiquidatable
            ? "nothing while the account is liquidatable"
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
                : `nothing yet: idle USDC (${formatUsd(state.freeUsdc)}) is under the ${formatUsd(launch.minDepositUsdc)} minimum deposit and leverage is inside its band`;

  const collect = async () => {
    if (!publicKey) return;
    setCollecting(true);
    setCollectNote(null);
    try {
      const sources = await client.findWithheldAccounts(launch.mint);
      if (sources.length === 0 && state.withheldOnMint === 0n) {
        setCollectNote("No withheld tax was found on this mint or its token accounts. Nothing to sweep right now.");
        return;
      }
      const signature = await sendTx({
        title: `Sweep withheld ${symbol} tax`,
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
    if (!publicKey || !treasury || !market.data || !quoted || batch === 0n) return;
    const fee = platformFeeOf(quoted.out);
    const signature = await sendTx({
      title: `Sell a batch of ${symbol} tax`,
      rows: [
        ["Tax tokens sold", tokens(batch)],
        ["Pool quote", formatUsd(quoted.out, 6)],
        [`Platform fee (${platformFeeRate})`, formatUsd(fee, 6)],
        ["To the vault", formatUsd(quoted.out - fee, 6)],
        ["Platform treasury", treasury.toBase58()],
        ["Lowest price the program accepts", `${perToken(floor)} per token`],
        ["Pool", market.data.dlmm.pubkey.toBase58()],
        ["To your wallet", "nothing"],
      ],
      notes: [
        `Any wallet can send this. The swap is signed by the program for the vault's tax authority, not by your wallet. Of the USDC the pool pays, the program sends ${platformFeeRate} to the platform treasury as the platform fee and the rest to the vault. You pay the network fee and receive nothing.`,
        "The program itself fixes the batch size, the cooldown and the price floor. If the pool pays less than the floor, the transaction fails and nothing is sold.",
      ],
      computeUnits: PHOENIX_COMPUTE_UNITS,
      build: async () => {
        const swap = await buildTaxSwap(
          market.data!,
          launch,
          launchAddresses(launch.mint, client.programId).taxAuthority,
          batch,
        );
        return { instructions: [await client.convertTaxIx(publicKey, launch, batch, swap.instruction, treasury)] };
      },
    });
    if (signature) onDone();
  };

  const rebalance = async () => {
    if (!publicKey || !work.canRebalance) return;
    const signature = await sendTx({
      title: "Rebalance the vault",
      rows: work.canDeleverage
        ? [
            ["Leverage now", leverageText(state.leverageBps)],
            ["Cuts the position to", deleverageTo],
            ["To your wallet", "nothing"],
          ]
        : [
            ["Deposited as Phoenix collateral", formatUsd(work.deployUsdc, 6)],
            ["Leverage now", leverageText(state.leverageBps)],
            ["Leverage after the deposit", leverageText(leverageAfterDeposit)],
            ["Adds exposure", exposureText(work.wouldIncrease)],
            ["To your wallet", "nothing"],
          ],
      notes: [
        work.canDeleverage
          ? `Any wallet can send this. Leverage is above ${max}, so the program closes exactly the part of the position that brings it down to ${deleverageTo}, at Phoenix's mark, and realises the loss on that part. Nothing is withdrawn.`
          : `Any wallet can send this. The program deposits all idle USDC not reserved for claims as collateral. If there is then no position, or leverage is under ${min}, it buys ${launch.symbol} perp at Phoenix's mark to bring leverage up to ${target}, never above, whether the position is in profit or not. At ${min} or above it adds no exposure.`,
        "You decide nothing about size, price or destination. You pay the network fee and receive nothing. If the vault's state has changed by the time this lands and there is nothing left to do, the transaction still succeeds and changes nothing.",
      ],
      computeUnits: PHOENIX_COMPUTE_UNITS,
      build: async () => ({ instructions: [await client.rebalanceIx(publicKey, launch)] }),
    });
    if (signature) onDone();
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
      ? "The protocol is paused; tax sales are refused."
      : work.convertBlockedBy === "no-pool"
        ? "The launch has no pool yet, so there is nowhere to sell tax."
        : work.convertBlockedBy === "below-threshold"
          ? `Collected tax is ${tokens(state.taxTokens)}; a batch needs at least ${tokens(launch.minConvertTokens)}.`
          : work.convertBlockedBy === "cooldown"
            ? `Cooldown: the next sale is allowed in ${cooldownLeft} slots (${formatSlots(cooldownLeft, SLOT_MS)}).`
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
                        {formatUsd(platformFeeOf(quoted.out), 6)} ({platformFeeRate}) is the platform fee and{" "}
                        {formatUsd(quoted.out - platformFeeOf(quoted.out), 6)} goes to the vault. The program itself
                        fixes the batch size and the price floor ({perToken(floor)} per token now), so whoever sends
                        this cannot sell the batch cheaply or keep any of it.
                        {belowFloor && (
                          <strong className="warn"> The current quote is below that floor: the program would refuse this sale.</strong>
                        )}
                      </>
                    );

  const needWallet = !publicKey;
  const convertReady = batch > 0n && !!quoted && !belowFloor && !!treasury;
  // a stale mark stops orders, not deposits
  const rebalanceReady = work.canDeleverage
    ? !state.markIsStale
    : work.canDeploy && (work.deployUsdc > 0n || !state.markIsStale);
  const pending = batch > 0n || work.canRebalance;
  const badge = (ready: boolean) => (needWallet ? "Any wallet" : ready ? "Can be sent now" : "Nothing to do now");

  return (
    <Panel id={ACTIVITY_ANCHOR} title="Vault upkeep" aside="open to any wallet">
      <p className="muted small">
        Nobody operates this vault and no key has a special role. Sweeping the withheld tax, selling it in the pool
        and rebalancing the position are steps any wallet can send. Whoever sends one decides only{" "}
        <strong>when</strong>: the program fixes the batch size, the price floor, the {platformFeeRate} platform fee,
        the order&apos;s size and price, and where the money goes, and the sender receives nothing. On Terp these
        steps travel with trades: a buy or sell made in the trade panel carries them when there is work. An open bot
        that anyone can run does the same for tokens nobody is trading here. If neither happens, tax simply waits and
        the position is not adjusted; redemptions and claim payouts never depend on it. The buttons below send the
        same steps by hand.
      </p>

      <Rows
        rows={[
          [
            "Platform fee",
            `${platformFeeRate} of each tax sale`,
            "of the USDC the pool pays, to the Terp platform treasury; the rest goes to the vault; fixed for this launch",
          ],
          [
            "Upkeep waiting",
            pending ? "yes: the next trade on Terp carries it, or send it below" : "nothing",
            paused
              ? "the protocol is paused: tax sales, deposits and new exposure are refused; a cut is not"
              : "tax ready to sell, or a position to deposit into, top up or cut",
          ],
          [
            "Collected tax waiting to be sold",
            `${tokens(state.taxTokens)} of ${tokens(launch.minConvertTokens)} needed`,
            `one batch sells at most ${tokens(launch.maxConvertTokens)}`,
          ],
          [
            "Withheld on the mint, not swept yet",
            tokens(state.withheldOnMint),
            "more may be withheld in individual token accounts; Sweep tax finds those",
          ],
          [
            "Sale cooldown",
            work.convertBlockedBy === "cooldown"
              ? `${cooldownLeft} slots left (${formatSlots(cooldownLeft, SLOT_MS)})`
              : launch.tokensConverted === 0n
                ? "none yet (no sale so far)"
                : "elapsed",
            `${launch.convertCooldownSlots} slots between tax sales`,
          ],
          [
            "Idle USDC available to deposit",
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
          ["Minimum", min, `under this after a deposit, a rebalance buys exposure back up to ${target}, in profit or not`],
          ["Cut threshold", max, `above this a rebalance cuts the position to ${deleverageTo}`],
          ["Position PnL", pnlText, "for information; the policy acts on leverage, not on profit or loss"],
          ["Next rebalance", nextRebalance, "from the USDC idle in the vault now; tax not yet sold adds to it"],
        ]}
      />
      <p className="muted small">
        The vault aims to keep its position open and close to {target}. A rebalance first adds the vault&apos;s idle
        USDC as collateral, which lowers leverage and moves the liquidation price further away. If leverage is then
        under {min}, it buys exposure back up to {target}, with or without new tax and whether the position is in
        profit or not, so gains are compounded into a larger position. Between {min} and {target} nothing is traded,
        which avoids paying taker fees for small drifts. Between {target} and {max}, usually after {launch.symbol}{" "}
        fell, tax is collateral only and pulls leverage back down. Above {max} a rebalance cuts the position to{" "}
        {deleverageTo}. The same rule opens the first position and re-opens one that was closed or liquidated.
      </p>

      {needWallet && <Notice><p>Connect a wallet to send any of these steps. Every one of them is open to any wallet.</p></Notice>}

      <ul className="events work">
        <Work
          title="Sweep tax"
          badge={needWallet ? "Any wallet" : "Checked when you click"}
          status={
            collectNote ??
            `Sweeps withheld ${formatBps(launch.transferFeeBps)} transfer-tax tokens from the mint and from token accounts into the vault's tax account. It is what makes a sale possible. You pay the network fee and receive nothing.`
          }
          action={{
            label: collecting ? "Finding withheld tax…" : "Sweep tax",
            enabled: !needWallet && !collecting,
            onClick: collect,
          }}
        />
        <Work
          title="Sell tax batch"
          badge={badge(convertReady)}
          good={!needWallet && convertReady}
          status={
            <>
              {convertStatus} You pay the network fee and receive nothing.
            </>
          }
          action={{ label: "Sell tax batch", enabled: !needWallet && convertReady, onClick: convert }}
        />
        <Work
          title="Rebalance"
          badge={badge(rebalanceReady)}
          good={!needWallet && rebalanceReady}
          status={`Right now a rebalance does this: ${nextRebalance}. The program decides the amounts and prices; you pay the network fee and receive nothing.`}
          action={{ label: "Rebalance", enabled: !needWallet && rebalanceReady, onClick: rebalance }}
        />
        <Work
          title="Unwrap"
          badge={badge(work.canonicalToUnwrap > 0n)}
          good={!needWallet && work.canonicalToUnwrap > 0n}
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
          badge={badge(work.claimsShortfall > 0n)}
          good={!needWallet && work.claimsShortfall > 0n}
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
