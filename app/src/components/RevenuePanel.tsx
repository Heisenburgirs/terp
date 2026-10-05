import type { Launch } from "@terp/sdk";
import { formatAtoms, formatBps, formatUsd } from "@/lib/format";
import { Panel, Rows } from "./ui";

export function RevenuePanel({ launch, symbol }: { launch: Launch; symbol: string }) {
  const tokens = (amount: bigint) => `${formatAtoms(amount, launch.decimals)} ${symbol}`;
  const keeperFee = formatBps(launch.keeperFeeBps);
  return (
    <Panel title="Actual converted revenue" aside="on-chain counters">
      <Rows
        rows={[
          ["Tax tokens collected", tokens(launch.tokensCollected)],
          ["Tax tokens converted", tokens(launch.tokensConverted)],
          [
            "Pool proceeds of converted tax",
            formatUsd(launch.usdcConverted + launch.keeperFeesPaid),
            "everything the pool paid for the tax, before the keeper fee",
          ],
          [
            "Keeper fee paid to the platform",
            formatUsd(launch.keeperFeesPaid),
            `${keeperFee} of each conversion, to the Terp treasury; not part of the vault`,
          ],
          [
            "USDC converted, to the vault",
            formatUsd(launch.usdcConverted),
            "actual vault revenue: pool proceeds less the keeper fee",
          ],
          ["USDC deposited as collateral", formatUsd(launch.usdcDeposited)],
          ["USDC withdrawn from Phoenix", formatUsd(launch.usdcWithdrawn)],
          ["Tokens redeemed (burned)", tokens(launch.tokensRedeemed)],
          ["USDC paid or owed to redeemers", formatUsd(launch.usdcRedeemed), "payouts, including the part still outstanding as claims"],
          [
            "Outstanding claims",
            formatUsd(launch.pendingClaims, 6),
            "owed to redeemers whose Phoenix withdrawal was queued; already deducted from E",
          ],
          ["Redemption fees retained", formatUsd(launch.redemptionFeesRetained)],
          ["Exit costs retained", formatUsd(launch.exitCostsRetained)],
        ]}
      />
      <p className="muted small">
        These are cumulative totals the program recorded as tokens and USDC actually moved. Revenue is what the tax
        tokens really sold for, not trading volume multiplied by {formatBps(launch.transferFeeBps)}. One thing is
        deducted from a conversion: the platform&apos;s keeper fee, {keeperFee} of what the pool pays, fixed for this
        launch when it was created. It goes to the Terp treasury and never reaches the vault. Apart from that, nothing
        leaves a vault except redemptions.
      </p>
    </Panel>
  );
}
