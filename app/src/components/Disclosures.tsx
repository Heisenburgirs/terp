"use client";

import { MAX_PLATFORM_FEE_BPS, type Launch } from "@terp/sdk";
import type { ReactNode } from "react";
import { useUpgradeAuthority } from "@/hooks/useChain";
import { useProtocol } from "@/hooks/useClient";
import { PROGRAM_ID } from "@/lib/env";
import { formatBps, formatLeverage } from "@/lib/format";
import { Address, Rows } from "./ui";

/**
 * Who can change what about a launched token. `vault` is the launch PDA once it is known;
 * `transferFeeBps` is the token's tax tier once chosen (1% or 3%).
 */
export function AuthorityList({ vault, transferFeeBps }: { vault?: ReactNode; transferFeeBps?: number }) {
  const upgrade = useUpgradeAuthority();
  const protocol = useProtocol();
  const treasury = protocol.status === "ready" ? <Address value={protocol.config.treasury} /> : "reading…";
  const upgradeAuthority = upgrade.error ? (
    <span className="bad" title={upgrade.error}>could not be read</span>
  ) : upgrade.data === undefined ? (
    "reading…"
  ) : upgrade.data === null ? (
    "could not be determined from chain"
  ) : upgrade.data.authority ? (
    <Address value={upgrade.data.authority} />
  ) : (
    "none (program is immutable)"
  );

  return (
    <Rows
      rows={[
        ["Mint authority", "removed", "supply is fixed; nothing can be minted"],
        ["Freeze authority", "none", "no account can be frozen"],
        [
          "Transfer-fee authority",
          "none",
          transferFeeBps !== undefined
            ? `the transfer tax is immutable at ${formatBps(transferFeeBps)}`
            : "the transfer tax (1% or 3%, chosen at launch) is immutable",
        ],
        [
          "Withdraw-withheld authority",
          vault ?? "the launch vault PDA",
          "only the vault program can collect the tax; no wallet can",
        ],
        ["Metadata update authority", "removed", "name, symbol and URI cannot change"],
        [
          "Vault upkeep (sweeping tax, selling it, rebalancing)",
          "no key: open to any wallet",
          "the program fixes amounts, prices and destinations, and the sender receives nothing; the steps travel with trades made on Terp, and an open bot anyone can run covers quiet tokens",
        ],
        [
          "Platform treasury",
          treasury,
          `receives the platform fee from every tax sale, at the rate fixed when the launch was created (at most ${formatBps(MAX_PLATFORM_FEE_BPS)}); the admin can replace it`,
        ],
        [
          "Pool liquidity seeded at launch",
          "the vault, locked, if launched on this site",
          "positions owned by the vault that never unlock; each token's page shows from chain whether that holds; not enforced by the vault program",
        ],
        [
          "Pool swap fees",
          "the vault, on claim",
          "only the creator's wallet (the positions' operator) can trigger a claim, and Meteora pays it only to the vault",
        ],
        ["Program upgrade authority", upgradeAuthority, "the deployer can upgrade the vault program"],
        ["Vault program", <Address key="program" value={PROGRAM_ID} />],
      ]}
    />
  );
}

/** Risks of holding one launch's token. Rates and the asset are that launch's own. */
export function RiskSection({ launch }: { launch: Launch }) {
  const tax = formatBps(launch.transferFeeBps);
  const target = formatLeverage(launch.targetLeverageBps);
  const min = formatLeverage(launch.minLeverageBps);
  const max = formatLeverage(launch.maxLeverageBps);
  const deleverageTo = formatLeverage(launch.deleverageToBps);
  const platformFee = formatBps(launch.platformFeeBps);
  return (
    <ul className="risks">
      <li>Neither principal nor yield is guaranteed. You can lose everything you put in.</li>
      <li>
        The vault holds a leveraged {launch.symbol} {launch.direction} that aims for {target}; it is not a constant{" "}
        {target}. If {launch.symbol} moves against it, a liquidation on Phoenix can destroy the backing; redemption
        value can fall to zero. The asset was chosen by the creator at launch and cannot be changed.
      </li>
      <li>
        Not all of the tax reaches the vault. {platformFee} of the USDC every tax sale brings in is paid to the Terp
        platform treasury as the platform fee, fixed for this launch when it was created. Only the rest becomes vault
        equity.
      </li>
      <li>
        Leverage is held near {target} even while the position is below its entry price: whenever leverage is under{" "}
        {min}, a rebalance buys exposure back up to {target}, in profit or not. Liquidation is therefore never far
        away, roughly a 15–20% adverse move from {target}; an asset more volatile than SOL gets there faster.
      </li>
      <li>
        Top-ups compound. After gains the position is re-levered at higher prices, with or without new tax, so a
        reversal in {launch.symbol} hits a bigger position.
      </li>
      <li>
        Between {target} and {max} nothing is cut; tax only adds collateral. Above {max} a rebalance, which any wallet
        can send, cuts the position to {deleverageTo}, which realises the loss on the part that is closed. In a steady decline without
        enough tax, repeated cuts shrink the position, the same decay leveraged tokens have.
      </li>
      <li>
        Cuts and added collateral only help when someone sends them, and nothing guarantees that anyone does in time.
        A price gap bigger than the cushion can liquidate the position before either happens.
      </li>
      <li>
        Added collateral only protects the position if tax keeps arriving and someone&apos;s transaction deposits it.
        With little trading, or in a fast drop, the position can still be liquidated.
      </li>
      <li>
        A profitable perp position does not make token buyers profitable. Market price can sit above or below
        redemption value, every transfer costs the {tax} transfer tax, and every redemption costs the separate{" "}
        {formatBps(launch.redemptionFeeBps)} redemption fee plus an exit cost.
      </li>
      <li>
        Pool liquidity is separate from perp collateral and is not part of redemption backing. A launch made on this
        site seeds the pool with tokens only, in positions owned by the vault and locked for good; the &quot;Pool
        liquidity&quot; section of this page shows, from chain, whether that is true for this token. The lock is made
        by the create flow and is not enforced by the Terp program: a launch made with other tooling can be unlocked.
        Liquidity that others add next to it is theirs and is not locked.
      </li>
      <li>
        The pool starts with no USDC in it: buyers&apos; USDC fills it as the price rises along the seeded range, and
        there is no later migration to another pool. Early prices move a lot per dollar traded, and Meteora&apos;s
        swap fee rises with the number of price bins a swap crosses, so a large early buy can pay several times the
        pool&apos;s base fee on top of the {tax} transfer tax. Those fees go to the pool&apos;s positions and reach
        the vault only when the creator&apos;s wallet claims them; if it never does, they stay in the positions.
      </li>
      <li>
        Seeding the pool is itself a taxed transfer, so the vault starts with tax tokens ({tax} on top of the pool
        allocation). They are sold into the pool over time like any other tax, which is sell pressure from the first
        sales on.
      </li>
      <li>
        Tax tokens that have not been sold yet are not part of vault equity, and sell for less than market price: a
        conversion pays the {tax} transfer tax, the pool&apos;s swap fee and its own price impact.
      </li>
      <li>
        Nobody is obliged to run the vault. Selling tax and rebalancing the position happen when a transaction
        carries those steps: trades made on Terp do, and an open bot that anyone can run does for quiet tokens. If
        nobody trades this token on Terp and no bot runs, tax sits unsold, USDC sits idle and the position is not
        adjusted, in either direction. Redemptions and claim payouts do not depend on any of it.
      </li>
      <li>
        Because those steps are open to everyone, someone can send them at a moment that suits them: push the pool
        price down, as far as the program&apos;s price floor allows, just before a tax sale, or pick the moment of a
        perp order. The program fixes the batch size, the cooldown, the price floor and the order&apos;s limit against
        Phoenix&apos;s mark, and the sender is paid nothing, so what this can cost the vault per step is bounded. It
        is not zero.
      </li>
      <li>
        A redemption is one transaction, valued at Phoenix&apos;s mark price in that transaction. If the vault&apos;s
        idle USDC does not cover it, the same transaction closes your share of the position, and you pay what that
        actually costs if it is more than the {formatBps(launch.exitCostBps)} minimum. It fails, and needs a retry with a
        smaller amount, if the {launch.symbol} order book cannot absorb your share within{" "}
        {formatBps(launch.orderSlippageBps)} of mark.
      </li>
      <li>
        Phoenix throttles withdrawals exchange-wide. If it queues the withdrawal inside your redemption, your tokens
        are still burned and the unpaid part becomes a claim: payout is delayed until the USDC arrives, but the amount
        is fixed and ranks ahead of the remaining holders&apos; equity.
      </li>
      <li>
        The vault program is upgradeable by its deployer and depends on Phoenix and Meteora operating correctly. The
        protocol admin can pause tax sales and the opening of new exposure, can replace the treasury, and can change the platform fee for launches created later (not for this one).
      </li>
    </ul>
  );
}
