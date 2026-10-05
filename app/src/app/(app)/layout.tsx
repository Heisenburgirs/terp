import type { Metadata } from "next";
import type { ReactNode } from "react";
import { configPda } from "@terp/sdk";
import { TAGLINE } from "@/lib/brand";
import { formatLeverage, PROTOCOL_POLICY } from "@/lib/format";
import { Providers } from "@/components/Providers";
import { ENV_ERROR, PROGRAM_ID, RPC_URL } from "@/lib/env";
import "./wallet.css";

export const metadata: Metadata = {
  description:
    "Terp is a launchpad for fixed-supply Token-2022 tokens with a permanent 1% or 3% transfer tax. " +
    "The tax goes to the token's own on-chain vault, which sells it for USDC, pays the platform a fixed keeper fee and holds a leveraged long on the asset the creator chose, " +
    `kept open and close to ${formatLeverage(PROTOCOL_POLICY.targetLeverageBps)}: tax adds collateral, and the position is topped up to ${formatLeverage(PROTOCOL_POLICY.targetLeverageBps)} whenever leverage falls under ${formatLeverage(PROTOCOL_POLICY.minLeverageBps)}. ` +
    "Holders can redeem for a share of the vault. Neither principal nor yield is guaranteed.",
};

/**
 * Asks the RPC whether the protocol config account exists, so the first paint can already say
 * "not deployed". `null` means unknown; the browser repeats the check either way.
 */
async function configAccountExists(): Promise<boolean | null> {
  if (ENV_ERROR) return null;
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [configPda(PROGRAM_ID).toBase58(), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }],
      }),
      next: { revalidate: 30 },
    });
    const body = (await response.json()) as { result?: { value: unknown } };
    return body.result ? body.result.value !== null : null;
  } catch {
    return null;
  }
}

/** The launchpad itself: wallet and RPC providers, the header and the app footer. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Providers serverSawConfig={await configAccountExists()}>{children}</Providers>
      <footer className="site muted small">
        <div>
          <span>terp. {TAGLINE}</span>
          <span>
            Experimental software. Neither principal nor yield is guaranteed. Read the risks on each token page.
          </span>
        </div>
      </footer>
    </>
  );
}
