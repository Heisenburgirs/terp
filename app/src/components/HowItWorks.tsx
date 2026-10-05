"use client";

import { useProtocol } from "@/hooks/useClient";
import { PROTOCOL_POLICY, describeKeeperFee, formatLeverage } from "@/lib/format";

/** The model in six plain statements. Shown before any launch data, deployed or not. */
export function HowItWorks() {
  const protocol = useProtocol();
  const target = formatLeverage(PROTOCOL_POLICY.targetLeverageBps);
  const min = formatLeverage(PROTOCOL_POLICY.minLeverageBps);
  const max = formatLeverage(PROTOCOL_POLICY.maxLeverageBps);
  const deleverageTo = formatLeverage(PROTOCOL_POLICY.deleverageToBps);
  // the rate a launch created now would get; each launch keeps the rate it was created with
  const keeperFeeBps = protocol.status === "ready" ? protocol.config.keeperFeeBps : null;
  return (
    <section aria-labelledby="how-it-works">
      <h2 id="how-it-works" className="label" style={{ marginBottom: 10 }}>
        How it works
      </h2>
      <ol className="model">
        <li>Each token has its own vault.</li>
        <li>Tax tokens from every transfer go to that token&apos;s vault; no wallet can collect them.</li>
        <li>
          The vault sells the tax in the token&apos;s own pool for USDC. {describeKeeperFee(keeperFeeBps)}
          {keeperFeeBps !== null && " That is the rate for launches created now; each launch keeps the rate it was created with."}
        </li>
        <li>
          The vault&apos;s USDC is deposited on Phoenix as collateral for a long on the asset the creator chose, which
          the vault aims to keep open and close to {target}, in profit or not. Tax always adds collateral. Whenever
          leverage is under {min}, the position is topped up to {target}; between {min} and {target} nothing is
          traded; between {target} and {max} tax is collateral only, pulling leverage back down. Above {max} anyone can
          cut it to {deleverageTo}.
        </li>
        <li>When holders redeem, the vault unwinds their share and pays them USDC.</li>
        <li>
          The Terp keeper decides when tax is sold and deployed; the program fixes the sizes, the prices, the keeper
          fee and where the money goes. The keeper cannot withdraw anything, and redemptions do not depend on it.
        </li>
      </ol>
    </section>
  );
}
