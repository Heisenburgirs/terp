import { ticksToUsd, type VaultState } from "@terp/sdk";
import { describeKeeperFee, describePolicy, formatAtoms, formatBps, formatLeverage, formatLots, formatMandate, formatPrice, formatUsd } from "@/lib/format";
import { Notice, Panel, RiskBadge, Rows, riskMeaning } from "./ui";

export function VaultPanel({ state, symbol }: { state: VaultState; symbol: string }) {
  const { launch, perp, trader } = state;
  // the asset is the one this launch chose at creation; lots and ticks are converted with its own market units
  const position =
    perp.baseLots === 0n ? "none" : `${perp.baseLots > 0n ? "Long" : "Short"} ${formatLots(perp.baseLots, launch)}`;
  const target = formatLeverage(launch.targetLeverageBps);
  const min = formatLeverage(launch.minLeverageBps);
  const max = formatLeverage(launch.maxLeverageBps);
  const traderStatus = !launch.traderAccount
    ? "Not registered"
    : trader?.isOnboarded
      ? "Registered and onboarded"
      : "Registered, awaiting Phoenix onboarding";

  return (
    <Panel title="Vault" aside={`slot ${state.slot}`}>
      <div className="headline">
        <div>
          <span className="label">Net vault equity (E), after claims</span>
          <strong>{formatUsd(state.equity)}</strong>
        </div>
        <div>
          <span className="label">Leverage, aiming for {target}</span>
          <strong>{state.leverageBps === null ? "n/a" : formatLeverage(state.leverageBps)}</strong>
        </div>
        <div>
          <span className="label">Risk status</span>
          <RiskBadge risk={state.risk} policy={launch} />
        </div>
      </div>
      <p className="muted small">{riskMeaning(state.risk, launch)}</p>

      {state.markIsStale && (
        <Notice tone="warn" title="Stale mark price">
          <p>
            The Phoenix mark is older than {launch.maxMarkStalenessSlots.toString()} slots. The figures below use it
            anyway; redemptions, deployment and deleveraging are refused until it updates.
          </p>
        </Notice>
      )}
      {!launch.traderAccount && (
        <Notice tone="warn" title="Phoenix trader not registered">
          <p>
            The vault has no Phoenix trader account yet, so no exposure can be opened. Anyone can register it from the
            create page; Phoenix must then enable it.
          </p>
        </Notice>
      )}
      {launch.traderAccount && !trader?.isOnboarded && (
        <Notice tone="warn" title="Phoenix trader not onboarded">
          <p>
            Phoenix has not enabled deposits and orders for this vault&apos;s trader account, so the keeper&apos;s{" "}
            <code>deploy</code> cannot work yet and no exposure can be opened. Tax collection, conversion and redemptions against idle USDC
            work in the meantime.
          </p>
        </Notice>
      )}

      <Rows
        rows={[
          ["Vault mandate", formatMandate(launch), `the asset (${launch.symbol}) was chosen by the creator at launch and cannot change`],
          [
            "Funded by",
            `${formatBps(launch.transferFeeBps)} transfer tax`,
            "every transfer of this token; the tax tokens go to this vault",
          ],
          [
            "Keeper fee",
            `${formatBps(launch.keeperFeeBps)} of converted tax`,
            "paid to the Terp platform treasury out of every tax sale; the rest goes to this vault; fixed at launch",
          ],
          ["Idle USDC", formatUsd(state.idleUsdc), "in the vault; pays claims first, then redemptions"],
          ["Outstanding claims", formatUsd(launch.pendingClaims), "owed to earlier redeemers; deducted from E"],
          ["Idle USDC not reserved for claims", formatUsd(state.freeUsdc), "what redemptions and the keeper's next deployment can use"],
          ["In transit", formatUsd(state.canonical), "Phoenix canonical USDC held by the vault"],
          ["Phoenix collateral", formatUsd(perp.collateral)],
          [
            "Unrealized PnL",
            formatUsd(perp.unrealizedPnl),
            perp.baseLots === 0n ? "no position" : "for information; the policy acts on leverage, not on profit or loss",
          ],
          ["Unsettled funding", formatUsd(perp.unsettledFunding)],
          ["Phoenix account equity", formatUsd(perp.equity), "collateral + PnL + funding"],
          ["Perp exposure", position, `${launch.direction} mandate`],
          ["Notional", formatUsd(perp.notional)],
          [
            `${launch.symbol} mark price`,
            perp.markPriceTicks > 0n ? formatPrice(ticksToUsd(perp.markPriceTicks, launch)) : "n/a",
            "Phoenix perpetuals",
          ],
          [
            "Target leverage",
            target,
            "what the vault aims to hold; exposure is only ever added up to this",
          ],
          [
            "Minimum leverage",
            min,
            `under this after a deposit, a deployment buys exposure back up to ${target}; between ${min} and ${target} nothing is traded`,
          ],
          [
            "Maximum leverage",
            max,
            `above this any wallet may deleverage, which cuts the position to ${formatLeverage(launch.deleverageToBps)}`,
          ],
          ["Phoenix trader", traderStatus],
          ["Token supply (S)", `${formatAtoms(state.supply, launch.decimals)} ${symbol}`, "all unburned tokens"],
          [
            "Tax tokens not yet converted",
            `${formatAtoms(state.taxTokens + state.withheldOnMint, launch.decimals)} ${symbol}`,
            "not part of E",
          ],
        ]}
      />
      <p className="muted small">
        E = idle USDC + in-transit USDC + Phoenix account equity (floored at zero) − outstanding claims. {describePolicy(launch)}{" "}
        The same rule opens the first position and re-opens one that was closed or liquidated.{" "}
        {describeKeeperFee(launch.keeperFeeBps)} The Terp keeper
        decides when tax is sold and deployed; sizes, prices and destinations are computed by the program, and the
        keeper cannot withdraw anything. Pool liquidity is not part of E, locked or not; pool swap fees join E only
        once they are claimed into the vault.
      </p>
    </Panel>
  );
}
