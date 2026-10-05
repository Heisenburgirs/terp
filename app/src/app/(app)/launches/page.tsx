"use client";

import Link from "next/link";
import type { Launch } from "@terp/sdk";
import { HowItWorks } from "@/components/HowItWorks";
import { ProtocolGate } from "@/components/ProtocolGate";
import { Notice, RiskBadge } from "@/components/ui";
import { useAsync } from "@/hooks/useAsync";
import { useMarket, useTokenMeta } from "@/hooks/useChain";
import { useClient } from "@/hooks/useClient";
import { useVaultState } from "@/hooks/useVaultState";
import { TAGLINE } from "@/lib/brand";
import { formatBps, formatLeverage, formatMandate, formatPrice, formatUsd, shortKey } from "@/lib/format";

function LaunchRow({ launch }: { launch: Launch }) {
  const meta = useTokenMeta(launch.mint);
  const vault = useVaultState(launch);
  const market = useMarket(launch.pool, launch.mint);
  const state = vault.data;
  const pending = vault.error ? <span className="bad" title={vault.error}>unavailable</span> : "…";

  return (
    <tr>
      <td data-label="Token">
        <Link href={`/token/${launch.mint.toBase58()}`}>
          <strong className="ticker">{meta.data?.symbol ?? shortKey(launch.mint.toBase58())}</strong>
        </Link>
        <span className="muted small"> {meta.data?.name}</span>
      </td>
      <td data-label="Vault position">{formatMandate(launch)}</td>
      <td data-label="Transfer tax">{formatBps(launch.transferFeeBps)}</td>
      <td data-label="Market price">
        {!launch.pool ? (
          <span className="muted">no pool yet</span>
        ) : market.data ? (
          formatPrice(market.data.price)
        ) : market.error ? (
          <span className="bad" title={market.error}>unavailable</span>
        ) : (
          "…"
        )}
      </td>
      <td data-label="Redemption value">{state ? formatUsd(state.redemptionValuePerToken, 6) : pending}</td>
      <td data-label="Vault equity">{state ? formatUsd(state.equity) : pending}</td>
      <td data-label="Leverage">
        {state ? (state.leverageBps === null ? "n/a" : formatLeverage(state.leverageBps)) : pending}
      </td>
      <td data-label="Risk">{state ? <RiskBadge risk={state.risk} policy={launch} /> : pending}</td>
    </tr>
  );
}

function Discovery() {
  const client = useClient();
  const launches = useAsync(() => client.fetchAllLaunches(), "launches");

  if (launches.error) {
    return (
      <Notice tone="bad" title="Could not load launches">
        <p>{launches.error}</p>
        <button onClick={launches.reload}>Retry</button>
      </Notice>
    );
  }
  if (!launches.data) return <p className="muted">Loading launches…</p>;
  if (launches.data.length === 0) {
    return (
      <Notice title="No launches yet">
        <p>
          The protocol is deployed but nothing has been launched. <Link href="/create">Create the first launch.</Link>
        </p>
      </Notice>
    );
  }

  return (
    <div className="table-scroll" role="region" aria-label="Launches" tabIndex={0}>
      <table className="list">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Vault position</th>
            <th scope="col">Transfer tax</th>
            <th scope="col">Market price</th>
            <th scope="col">Redemption value / token</th>
            <th scope="col">Vault equity</th>
            <th scope="col">Leverage now</th>
            <th scope="col">Risk</th>
          </tr>
        </thead>
        <tbody>
          {launches.data.map((launch) => (
            <LaunchRow key={launch.address.toBase58()} launch={launch} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <h1>{TAGLINE}</h1>
      <p className="lead">
        Terp is a launchpad for fixed-supply Token-2022 tokens with a transfer tax of 1% or 3%, chosen by the creator
        at launch and permanent. The tax tokens do not go to a creator or a platform wallet. They go to an on-chain vault
        that belongs to that token alone; when they are sold, the platform takes a fixed platform fee and the vault keeps the rest.
      </p>
      <HowItWorks />
      <p className="lead" style={{ marginTop: 16 }}>
        No operator runs the vaults. Sweeping tax, selling it and rebalancing the position are open to any wallet and
        travel with trades made on Terp; the program fixes the batch size, the price floor, the order and where the
        money goes, and nobody who sends a step can withdraw anything. Holders can burn tokens for a proportional
        share of the vault&apos;s net equity at any time, whether or not anyone is trading. Market price and redemption value are different numbers.{" "}
        <strong>Neither principal nor yield is guaranteed</strong>: a leveraged position can be liquidated and the
        backing lost.
      </p>
      <section className="panel" aria-labelledby="launches">
        <header>
          <h2 id="launches">Launches</h2>
          <span className="muted small">read from chain; nothing here is sample data</span>
        </header>
        <ProtocolGate>
          <Discovery />
        </ProtocolGate>
      </section>
    </>
  );
}
