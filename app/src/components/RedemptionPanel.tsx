"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { USDC_DECIMALS, math, type RedemptionQuote, type VaultState } from "@terp/sdk";
import { useState } from "react";
import { useAsync, type AsyncState } from "@/hooks/useAsync";
import { useClient } from "@/hooks/useClient";
import { PHOENIX_COMPUTE_UNITS, useSendTx } from "@/hooks/useSendTx";
import type { Balances } from "@/lib/chain";
import { atomsToInput, formatAtoms, formatBps, formatLots, formatUsd, parseAtoms } from "@/lib/format";
import { Notice, Panel, Rows } from "./ui";

interface Props {
  state: VaultState;
  symbol: string;
  balances: AsyncState<Balances>;
  onDone: () => void;
}

function quoteRows(quote: RedemptionQuote, state: VaultState): [string, string, string?][] {
  const charge = quote.gross > 0n ? ((quote.gross - quote.payout) * 10_000n) / quote.gross : 0n;
  return [
    ["Gross share of vault equity", formatUsd(quote.gross, 6), "floor(q × E / S)"],
    [`Redemption fee (${formatBps(state.launch.redemptionFeeBps)})`, `-${formatUsd(quote.redemptionFee, 6)}`, "stays in the vault"],
    [
      `Exit cost (${formatBps(state.launch.exitCostBps)} of your slice of open notional)`,
      `-${formatUsd(quote.exitCost, 6)}`,
      "minimum; actual cost of closing your share is charged if higher",
    ],
    ["Payout", formatUsd(quote.payout, 6), "preview at the current mark"],
    ["Effective total charge", formatBps(charge), "of gross, at the minimum exit cost"],
  ];
}

export function RedemptionPanel({ state, symbol, balances, onDone }: Props) {
  const client = useClient();
  const sendTx = useSendTx();
  const { publicKey } = useWallet();
  const { launch } = state;
  const [amountText, setAmountText] = useState("");
  const [minPayoutText, setMinPayoutText] = useState<string | null>(null);

  const claim = useAsync(
    () => client.fetchClaim(launch.address, publicKey!),
    publicKey ? `${launch.address.toBase58()}:${publicKey.toBase58()}` : null,
    10_000,
  );
  const done = () => {
    claim.reload();
    onDone();
  };

  const amount = parseAtoms(amountText, launch.decimals);
  const quote = amount && amount > 0n && amount <= state.supply ? client.previewRedemption(state, amount) : null;
  const defaultMinPayout = quote ? (quote.payout * 99n) / 100n : 0n;
  const minPayout = minPayoutText === null ? defaultMinPayout : parseAtoms(minPayoutText, USDC_DECIMALS);
  const balance = balances.data?.token;

  // Whether the vault's unreserved idle USDC pays this, or the transaction has to close the holder's slice.
  const closesPosition = !!quote && (quote.payout > state.freeUsdc || quote.isFinal) && state.perp.notional > 0n;
  const fromPhoenix = quote && quote.payout > state.freeUsdc ? quote.payout - state.freeUsdc : 0n;
  const baseLots = state.perp.baseLots < 0n ? -state.perp.baseLots : state.perp.baseLots;
  const sliceLots = quote && amount ? math.proRataCeil(baseLots, amount, state.supply) : 0n;
  const slice = formatLots(sliceLots, launch);

  const problem = !amount
    ? null
    : amount < launch.minRedeemTokens
      ? `The minimum redemption is ${formatAtoms(launch.minRedeemTokens, launch.decimals)} ${symbol}.`
      : amount > state.supply
        ? "That is more than the whole supply."
        : balance !== undefined && amount > balance
          ? "That is more than your balance."
          : !minPayout || minPayout <= 0n
            ? "The minimum payout must be above zero."
            : state.markIsStale
              ? "The Phoenix mark price is stale; the program refuses to value a redemption on it. Try again once it updates."
              : fromPhoenix > 0n && !state.trader
                ? `The vault has ${formatUsd(state.freeUsdc)} of idle USDC available and no Phoenix account to withdraw from. Redeem a smaller amount.`
                : null;
  const aboveQuote = quote && minPayout && minPayout > quote.payout;

  const submitRedeem = async () => {
    if (!publicKey || !amount || !quote || !minPayout) return;
    const signature = await sendTx({
      title: `Redeem ${symbol}`,
      rows: [
        ["Tokens burned", `${formatAtoms(amount, launch.decimals)} ${symbol}`],
        ["Payout at the current mark (preview)", formatUsd(quote.payout, 6)],
        ["Minimum payout you accept", formatUsd(minPayout, 6)],
        [
          "Paid from",
          fromPhoenix > 0n
            ? `${formatUsd(state.freeUsdc)} idle USDC + about ${formatUsd(fromPhoenix)} withdrawn from Phoenix`
            : "the vault's idle USDC",
        ],
        ...(closesPosition ? ([["Position closed by this transaction", `about ${slice} (your share)`]] as [string, string][]) : []),
      ],
      notes: [
        "One transaction: it burns the tokens and pays USDC, valued at Phoenix's mark price when it executes. It fails, and nothing is burned, if the payout would be below your minimum.",
        closesPosition
          ? `Closing your share is charged at what it actually costs if that is more than the minimum exit cost shown. If the ${launch.symbol} order book cannot absorb it within ${formatBps(launch.orderSlippageBps)} of mark, the transaction fails: retry, or redeem a smaller amount.`
          : fromPhoenix > 0n
            ? "The vault has no open position, so nothing is closed; the difference is withdrawn from its Phoenix collateral."
            : "The vault's idle USDC covers this payout, so no position is closed and the exit cost is the minimum shown.",
        ...(fromPhoenix > 0n
          ? [
              "If Phoenix queues the withdrawal instead of paying it, your tokens are still burned and the unpaid part becomes a fixed USDC claim in your name, paid when the USDC arrives.",
            ]
          : []),
        `Burning is not a transfer, so the ${formatBps(launch.transferFeeBps)} transfer tax does not apply. The ${formatBps(launch.redemptionFeeBps)} redemption fee is a separate charge and does. Your USDC account, and a small claim account that is closed again when nothing is owed, are created if needed.`,
      ],
      computeUnits: PHOENIX_COMPUTE_UNITS,
      build: async () => ({ instructions: await client.redeemIxs(publicKey, launch, amount, minPayout) }),
    });
    if (signature) {
      setAmountText("");
      setMinPayoutText(null);
      done();
    }
  };

  const owed = claim.data?.amount ?? 0n;
  const payable = owed < state.idleUsdc ? owed : state.idleUsdc;
  const submitPayClaim = async () => {
    if (!publicKey || owed === 0n) return;
    const signature = await sendTx({
      title: "Pay out your claim",
      rows: [
        ["Your outstanding claim", formatUsd(owed, 6)],
        ["Vault idle USDC", formatUsd(state.idleUsdc, 6)],
        ["Paid now", formatUsd(payable, 6)],
        ["Still owed afterwards", formatUsd(owed - payable, 6)],
      ],
      notes: [
        "Pays as much of the claim as the vault's idle USDC covers. Any wallet can send this transaction, with or without the keeper; the money can only go to the claim's owner.",
      ],
      build: async () => ({ instructions: await client.payClaimIxs(publicKey, launch, publicKey) }),
    });
    if (signature) done();
  };

  return (
    <Panel title="Redeem" aside="burn tokens for a share of vault equity">
      <ul className="plain muted small">
        <li>
          <strong>One transaction.</strong> It burns your tokens and pays USDC. The value is fixed in that transaction,
          at Phoenix&apos;s mark price.
        </li>
        <li>
          The {formatBps(launch.transferFeeBps)} transfer tax does not apply, because tokens are burned, not
          transferred. The {formatBps(launch.redemptionFeeBps)} redemption fee is a separate charge: it stays in the
          vault for the remaining holders.
        </li>
        <li>
          If the vault&apos;s idle USDC does not cover the payout, your transaction closes your share of the{" "}
          {launch.symbol} position and withdraws the difference from Phoenix.
        </li>
        <li>
          If Phoenix queues that withdrawal, you receive a fixed claim instead, which is paid when the USDC arrives.
        </li>
      </ul>

      {!publicKey && <Notice><p>Connect a wallet to redeem.</p></Notice>}
      {claim.error && <Notice tone="bad" title="Could not load your claim"><p>{claim.error}</p></Notice>}

      {owed > 0n && (
        <Notice tone="warn" title="You have an outstanding claim">
          <Rows
            rows={[
              ["Owed to you", formatUsd(owed, 6), "fixed; from a redemption whose Phoenix withdrawal was queued"],
              ["Vault idle USDC", formatUsd(state.idleUsdc, 6), "claims are paid from this"],
            ]}
          />
          {state.idleUsdc === 0n && (
            <p className="small">
              The USDC has not arrived from Phoenix yet. Nothing can be paid until it does; the amount owed does not
              change in the meantime.
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={state.idleUsdc === 0n} onClick={submitPayClaim}>
              Pay out claim
            </button>
          </div>
        </Notice>
      )}

      <label>
        <span>
          Amount ({symbol})
          {balance !== undefined && (
            <small>
              {" "}
              balance {formatAtoms(balance, launch.decimals)}{" "}
              <button className="link" onClick={() => setAmountText(atomsToInput(balance, launch.decimals))}>
                max
              </button>
            </small>
          )}
        </span>
        <input
          inputMode="decimal"
          placeholder="0.0"
          value={amountText}
          onChange={(event) => setAmountText(event.target.value)}
        />
      </label>
      {amountText && amount === null && <p className="bad small">Enter a valid amount.</p>}

      {quote && (
        <>
          <Rows rows={quoteRows(quote, state)} />
          {quote.isFinal ? (
            <p className="small">
              This is the entire supply: the last holder takes all remaining equity once the whole position is closed,
              and no fee applies.
            </p>
          ) : closesPosition ? (
            <p className="small">
              The vault has {formatUsd(state.freeUsdc)} of idle USDC available, less than this payout. Your transaction
              closes about {slice} of the position (your share) and withdraws about {formatUsd(fromPhoenix)} from
              Phoenix. The exit cost above is a minimum: if closing your share costs more, you are charged the actual
              cost, down to your minimum payout.
            </p>
          ) : fromPhoenix > 0n ? (
            <p className="small">
              The vault has {formatUsd(state.freeUsdc)} of idle USDC available, less than this payout. It has no open
              position, so nothing is closed; your transaction withdraws about {formatUsd(fromPhoenix)} from its
              Phoenix collateral.
            </p>
          ) : (
            <p className="small">
              The vault&apos;s idle USDC ({formatUsd(state.freeUsdc)} available) covers this payout, so no position is
              closed and the exit cost is the minimum shown.
            </p>
          )}
          <label>
            <span>
              Minimum payout (USDC)
              <small> default: 1% below the preview</small>
            </span>
            <input
              inputMode="decimal"
              value={minPayoutText ?? atomsToInput(defaultMinPayout, USDC_DECIMALS)}
              onChange={(event) => setMinPayoutText(event.target.value)}
            />
          </label>
        </>
      )}
      {problem && <p className="bad small">{problem}</p>}
      {aboveQuote && (
        <p className="warn small">
          Your minimum payout is above the current preview; the redemption will fail unless the vault&apos;s value rises.
        </p>
      )}
      <button className="primary" disabled={!publicKey || !quote || problem !== null} onClick={submitRedeem}>
        {publicKey ? "Redeem" : "Connect a wallet to redeem"}
      </button>

      <Rows
        rows={[
          [
            "Total outstanding claims of this vault",
            formatUsd(launch.pendingClaims, 6),
            "owed to earlier redeemers; already deducted from E",
          ],
        ]}
      />
    </Panel>
  );
}
