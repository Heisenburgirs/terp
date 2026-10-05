"use client";

import { PublicKey } from "@solana/web3.js";
import { USDC_DECIMALS, type VaultState } from "@terp/sdk";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { AuthorityList, RiskSection } from "@/components/Disclosures";
import { HistoryPanel } from "@/components/HistoryPanel";
import { LiquidityPanel } from "@/components/LiquidityPanel";
import { ProtocolGate } from "@/components/ProtocolGate";
import { RedemptionPanel } from "@/components/RedemptionPanel";
import { RevenuePanel } from "@/components/RevenuePanel";
import { TradePanel } from "@/components/TradePanel";
import { Address, Notice, Panel, Rows } from "@/components/ui";
import { VaultActivityPanel } from "@/components/VaultActivityPanel";
import { VaultPanel } from "@/components/VaultPanel";
import type { AsyncState } from "@/hooks/useAsync";
import { useBalances, useLiquidityLock, useMarket, useTokenMeta } from "@/hooks/useChain";
import { useVaultState } from "@/hooks/useVaultState";
import type { Market } from "@/lib/chain";
import { describeKeeperFee, describePolicy, formatAtoms, formatBps, formatMandate, formatPercent, formatPrice, formatUsd, shortKey } from "@/lib/format";

const POLL_MS = 10_000;
/** The lock status needs a `getProgramAccounts` call, so it is refreshed less often. */
const LOCK_POLL_MS = 60_000;

function Valuation({ state, market }: { state: VaultState; market: AsyncState<Market> }) {
  const redemption = Number(state.redemptionValuePerToken) / 10 ** USDC_DECIMALS;
  const price = market.data?.price;
  const premium = price !== undefined && redemption > 0 ? (price / redemption - 1) * 100 : null;

  return (
    <section className="valuation">
      <div>
        <span className="label">Market price</span>
        <strong>
          {!state.launch.pool ? "no pool" : price !== undefined ? formatPrice(price) : market.error ? "unavailable" : "…"}
        </strong>
        <span className="muted small">What the pool trades at now (active bin), before fees.</span>
      </div>
      <div>
        <span className="label">Redemption value per token</span>
        <strong>{formatUsd(state.redemptionValuePerToken, 6)}</strong>
        <span className="muted small">
          Vault equity after claims ÷ supply (E / S), before the {formatBps(state.launch.redemptionFeeBps)} redemption fee and exit
          cost.
        </span>
      </div>
      <div>
        <span className="label">Market vs redemption value</span>
        <strong>
          {premium === null ? "n/a" : `${formatPercent(premium)} ${premium >= 0 ? "premium" : "discount"}`}
        </strong>
        <span className="muted small">
          These are two different numbers. Buying below redemption value and redeeming is legitimate arbitrage, but
          only pays after the {formatBps(state.launch.transferFeeBps)} transfer tax on the buy, the{" "}
          {formatBps(state.launch.redemptionFeeBps)} redemption fee and the exit cost. Redeeming itself burns
          tokens and pays no transfer tax.
        </span>
      </div>
    </section>
  );
}

function Allocation({ state, market, symbol }: { state: VaultState; market: AsyncState<Market>; symbol: string }) {
  const { launch } = state;
  const creator = useBalances(launch.mint, undefined, launch.creator);
  const tokens = (amount: bigint) => `${formatAtoms(amount, launch.decimals)} ${symbol}`;
  const share = (amount: bigint) =>
    launch.initialSupply > 0n ? ` (${formatBps((amount * 10_000n) / launch.initialSupply)})` : "";

  return (
    <Panel title="Allocation and authorities">
      <Rows
        rows={[
          ["Initial supply", tokens(launch.initialSupply)],
          ["Creator allocation at launch", tokens(launch.creatorAllocation) + share(launch.creatorAllocation), "as disclosed by the creator"],
          ["Pool allocation at launch", tokens(launch.poolAllocation) + share(launch.poolAllocation), "as disclosed by the creator"],
          ["Current supply", tokens(state.supply), "after redemptions burned tokens"],
          ["Creator wallet", <Address key="creator" value={launch.creator} />],
          [
            "Creator wallet balance now",
            creator.data ? tokens(creator.data.token) : creator.error ? "unavailable" : "…",
            "the creator's own token account only",
          ],
          [
            "Tokens in the pool now",
            !launch.pool ? "no pool" : market.data ? tokens(market.data.tokenReserve) : market.error ? "unavailable" : "…",
          ],
          [
            "USDC in the pool now",
            !launch.pool ? "no pool" : market.data ? formatUsd(market.data.usdcReserve) : market.error ? "unavailable" : "…",
            "not redemption backing",
          ],
          ["Pool", launch.pool ? <Address key="pool" value={launch.pool} /> : "not set"],
        ]}
      />
      <p className="muted small">
        The allocation split is what the creator declared at launch; the program only checks that it adds up to the
        supply. Who owns the pool&apos;s liquidity, and whether it is locked, is read from chain under &quot;Pool
        liquidity&quot; above. Seeding the pool is a taxed transfer: the tax on it comes out of the creator
        allocation and starts in the vault as unsold tax tokens.
      </p>
      <AuthorityList vault={<Address value={launch.address} />} transferFeeBps={launch.transferFeeBps} />
    </Panel>
  );
}

function TokenDetail({ mint }: { mint: PublicKey }) {
  const vault = useVaultState(mint, POLL_MS);
  const meta = useTokenMeta(mint);
  const state = vault.data;
  const market = useMarket(state?.launch.pool ?? null, mint, POLL_MS);
  const balances = useBalances(mint, POLL_MS);
  const lock = useLiquidityLock(market.data, state?.launch.address ?? null, LOCK_POLL_MS);

  if (vault.error && !state) {
    return (
      <Notice tone="bad" title="Could not load this vault">
        <p>{vault.error}</p>
        <button onClick={vault.reload}>Retry</button>
      </Notice>
    );
  }
  if (state === undefined) return <p className="muted">Loading vault…</p>;
  if (state === null) {
    return (
      <Notice title="No launch for this mint">
        <p>
          <span className="mono">{mint.toBase58()}</span> has no launch account under this program.
        </p>
      </Notice>
    );
  }

  const symbol = meta.data?.symbol || shortKey(mint.toBase58());
  const refresh = () => {
    vault.reload();
    market.reload();
    balances.reload();
    lock.reload();
  };

  return (
    <>
      <h1>
        {meta.data?.name || "Unnamed token"} <span className="muted ticker">{symbol}</span>
      </h1>
      <dl className="facts">
        <div>
          <dt>Vault position</dt>
          <dd>{formatMandate(state.launch)}</dd>
        </div>
        <div>
          <dt>Transfer tax</dt>
          <dd>{formatBps(state.launch.transferFeeBps)}</dd>
        </div>
        <div>
          <dt>Redemption fee</dt>
          <dd>{formatBps(state.launch.redemptionFeeBps)}</dd>
        </div>
        <div>
          <dt>Mint</dt>
          <dd>
            <Address value={mint} full />
          </dd>
        </div>
      </dl>
      <p className="muted small">
        Tax tokens from every transfer of {symbol} go to this token&apos;s own vault. The vault sells them in the{" "}
        {symbol} pool for USDC. {describeKeeperFee(state.launch.keeperFeeBps)} The vault deposits its USDC on Phoenix
        and holds a {state.launch.symbol} {state.launch.direction}. {describePolicy(state.launch)} The Terp keeper decides when tax is sold and deployed
        and cannot withdraw anything; the program fixes sizes, prices and destinations. Holders can redeem for a share
        of the vault whether or not the keeper is online.
      </p>
      {meta.data?.description && <p className="lead">{meta.data.description}</p>}
      {vault.error && (
        <Notice tone="warn" title="Showing the last successful read">
          <p>The latest refresh failed: {vault.error}</p>
        </Notice>
      )}

      <Valuation state={state} market={market} />

      <div className="columns">
        <div>
          <TradePanel launch={state.launch} symbol={symbol} market={market} balances={balances} onDone={refresh} />
          <RedemptionPanel state={state} symbol={symbol} balances={balances} onDone={refresh} />
        </div>
        <div>
          <VaultPanel state={state} symbol={symbol} />
          <RevenuePanel launch={state.launch} symbol={symbol} />
        </div>
      </div>

      <VaultActivityPanel state={state} symbol={symbol} market={market} onDone={refresh} />
      <HistoryPanel launch={state.launch} symbol={symbol} />
      <LiquidityPanel launch={state.launch} symbol={symbol} market={market} lock={lock} onDone={refresh} />
      <Allocation state={state} market={market} symbol={symbol} />
      <Panel title="Risks">
        <RiskSection launch={state.launch} />
      </Panel>
    </>
  );
}

export default function TokenPage() {
  const { mint } = useParams<{ mint: string }>();
  const key = useMemo(() => {
    try {
      return new PublicKey(mint);
    } catch {
      return null;
    }
  }, [mint]);

  if (!key) {
    return (
      <Notice tone="bad" title="Invalid address">
        <p>The address in the URL is not a valid mint address.</p>
      </Notice>
    );
  }
  return (
    <ProtocolGate>
      <TokenDetail mint={key} />
    </ProtocolGate>
  );
}
