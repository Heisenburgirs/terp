"use client";

import { useProtocol } from "@/hooks/useClient";
import { PROTOCOL_POLICY, describePlatformFee, formatLeverage } from "@/lib/format";

/** The model in six plain statements. Shown before any launch data, deployed or not. */
export function HowItWorks() {
  const protocol = useProtocol();
  const target = formatLeverage(PROTOCOL_POLICY.targetLeverageBps);
  const min = formatLeverage(PROTOCOL_POLICY.minLeverageBps);
  const max = formatLeverage(PROTOCOL_POLICY.maxLeverageBps);
  const deleverageTo = formatLeverage(PROTOCOL_POLICY.deleverageToBps);
  // the rate a launch created now would get; each launch keeps the rate it was created with
  const platformFeeBps = protocol.status === "ready" ? protocol.config.platformFeeBps : null;
  return (
    <section aria-labelledby="how-it-works">
      <h2 id="how-it-works" className="label" style={{ marginBottom: 10 }}>
        How it works
      </h2>
      <ol className="model">
        <li>Each token has its own vault.</li>
        <li>Tax tokens from every transfer go to that token&apos;s vault; no wallet can collect them.</li>
        <li>
          The vault sells the tax in the token&apos;s own pool for USDC. {describePlatformFee(platformFeeBps)}
          {platformFeeBps !== null && " That is the rate for launches created now; each launch keeps the rate it was created with."}
        </li>
        <li>
          The vault&apos;s USDC is deposited on Phoenix as collateral for a long on the asset the creator chose, which
          the vault aims to keep open and close to {target}, in profit or not. Tax always adds collateral. Whenever
          leverage is under {min}, the position is topped up to {target}; between {min} and {target} nothing is
          traded; between {target} and {max} tax is collateral only, pulling leverage back down. Above {max} it is cut
          to {deleverageTo}.
        </li>
        <li>When holders redeem, the vault unwinds their share and pays them USDC.</li>
        <li>
          Nobody operates the vault. Selling tax and rebalancing the position are steps any wallet can send; they
          travel with trades made on Terp, and an open bot anyone can run covers quiet tokens. The program fixes the
          sizes, the prices, the platform fee and where the money goes, and whoever sends a step receives nothing.
          Redemptions do not depend on any of it.
        </li>
      </ol>
    </section>
  );
}
