"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { USDC_DECIMALS, fetchHistory, math, type HistoryEntry, type HistoryKind, type Launch } from "@terp/sdk";
import { useState } from "react";
import { useAsync } from "@/hooks/useAsync";
import { PROGRAM_ID, explorerUrl } from "@/lib/env";
import { formatAtoms, formatLeverage, formatLots, formatPrice, formatTime, formatUsd, shortKey } from "@/lib/format";
import { Notice, Panel } from "./ui";

const TABS: { label: string; kinds: HistoryKind[] }[] = [
  { label: "Tax", kinds: ["taxCollected", "taxConverted"] },
  { label: "Position", kinds: ["deployed", "deleveraged", "canonicalUnwrapped"] },
  { label: "Redemptions", kinds: ["redeemed", "claimPaid", "claimsFunded"] },
];

const HISTORY_LIMIT = 50;

/** One line per event. Fields are looked up by the program's own snake_case name, or its camelCase form. */
function describe(entry: HistoryEntry, launch: Launch, symbol: string): [title: string, detail: string] {
  const d = entry.data;
  const field = (key: string) => d[key] ?? d[key.replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase())];
  const int = (key: string) => {
    const value = field(key);
    return typeof value === "bigint" ? value : typeof value === "number" && Number.isInteger(value) ? BigInt(value) : 0n;
  };
  const tokens = (key: string) => `${formatAtoms(int(key), launch.decimals)} ${symbol}`;
  const usd = (key: string) => formatUsd(int(key), 6);
  // base lots of the launch's own perp market, shown in units of its asset
  const lots = (key: string) => formatLots(int(key), launch);
  const key = (name: string) => {
    const value = field(name);
    return typeof value === "string" ? shortKey(value) : "unknown";
  };

  switch (entry.kind) {
    case "taxCollected":
      return ["Tax collected", `${tokens("tokens")} moved to the vault's tax account`];
    case "taxConverted": {
      // the program's price is USDC atoms per token atom x 1e12
      const perToken = (Number(int("price")) / Number(math.PRICE_SCALE)) * 10 ** (launch.decimals - USDC_DECIMALS);
      const toVault = int("usdc_out") - int("keeper_fee");
      return [
        "Tax converted",
        `${tokens("tokens_in")} sold; the pool paid ${usd("usdc_out")} (${formatPrice(perToken)} per token): ` +
          `${usd("keeper_fee")} keeper fee to the platform, ${formatUsd(toVault, 6)} to the vault`,
      ];
    }
    case "deployed": {
      const increased = field("increased") === true;
      const before = formatLeverage(int("leverage_bps_before"));
      const after = formatLeverage(int("leverage_bps_after"));
      const min = formatLeverage(launch.minLeverageBps);
      const target = formatLeverage(launch.targetLeverageBps);
      return [
        increased
          ? `Deployed: collateral added, position topped up to ${target}`
          : `Deployed: collateral only (leverage at or above the ${min} minimum)`,
        `deposited ${usd("deposited")} as Phoenix collateral; ` +
          `leverage ${before} after the deposit → ${after}; ` +
          (increased
            ? `under the ${min} minimum (or no position), so exposure was added: bought ${lots("filled_base_lots")} of ${lots("requested_base_lots")} for ${usd("filled_quote_lots")}; `
            : `not under the ${min} minimum, so no exposure was added; `) +
          `position ${lots("base_lots_after")}, notional ${usd("notional_after")}, account equity ${usd("equity_after")}, unrealized PnL ${usd("unrealized_pnl")}`,
      ];
    }
    case "deleveraged":
      return [
        "Deleveraged",
        `sent by ${key("caller")}; closed ${lots("filled_base_lots")} of ${lots("requested_base_lots")} ` +
          `for ${usd("filled_quote_lots")}; leverage ${formatLeverage(int("leverage_bps_before"))} → ${formatLeverage(int("leverage_bps_after"))}`,
      ];
    case "canonicalUnwrapped":
      return ["Collateral unwrapped", `${usd("usdc")} back to idle USDC`];
    case "redeemed":
      return [
        "Redeemed",
        `${key("owner")} burned ${tokens("tokens_burned")}: gross ${usd("gross")}, fee ${usd("redemption_fee")}, ` +
          `exit cost ${usd("exit_cost")}, payout ${usd("payout")}; paid ${usd("paid")}` +
          (int("owed") > 0n ? `, ${usd("owed")} owed as a claim (Phoenix queued the withdrawal)` : "") +
          (int("base_lots_closed") > 0n ? `; closed ${lots("base_lots_closed")}` : "") +
          (int("usdc_withdrawn") > 0n ? `; withdrew ${usd("usdc_withdrawn")} from Phoenix` : ""),
      ];
    case "claimPaid":
      return ["Claim paid", `${key("owner")} received ${usd("usdc")}; ${usd("remaining")} still owed`];
    case "claimsFunded":
      return ["Claims funded", `requested ${usd("requested")} from Phoenix; ${usd("arrived")} arrived`];
    default:
      return [entry.kind, ""];
  }
}

export function HistoryPanel({ launch, symbol }: { launch: Launch; symbol: string }) {
  const { connection } = useConnection();
  const [tab, setTab] = useState(0);
  const history = useAsync(
    () => fetchHistory(connection, launch.address, { limit: HISTORY_LIMIT, programId: PROGRAM_ID }),
    launch.address.toBase58(),
  );
  const entries = history.data?.filter((entry) => TABS[tab].kinds.includes(entry.kind));

  return (
    <Panel
      title="History"
      aside={
        <button className="link" onClick={history.reload} disabled={history.loading}>
          {history.loading ? "loading…" : "refresh"}
        </button>
      }
    >
      <div className="tabs" role="tablist" aria-label="History kind">
        {TABS.map(({ label }, index) => (
          <button key={label} role="tab" aria-selected={tab === index} onClick={() => setTab(index)}>
            {label}
          </button>
        ))}
      </div>

      {history.error && <Notice tone="bad" title="Could not load history"><p>{history.error}</p></Notice>}
      {!history.data && !history.error && <p className="muted">Loading history…</p>}
      {entries?.length === 0 && <p className="muted">No events of this kind yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="events">
          {entries.map((entry, index) => {
            const [title, detail] = describe(entry, launch, symbol);
            return (
              <li key={`${entry.signature}:${index}`}>
                <div>
                  <strong>{title}</strong>
                  <span className="muted small">{formatTime(entry.blockTime)}</span>
                  <a className="mono small" href={explorerUrl("tx", entry.signature)} target="_blank" rel="noreferrer">
                    {shortKey(entry.signature)}
                  </a>
                </div>
                <span className="small">{detail}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">
        Rebuilt from the program&apos;s events in the launch&apos;s last {HISTORY_LIMIT} transactions. Every amount is
        what the program recorded as moved.
      </p>
    </Panel>
  );
}
