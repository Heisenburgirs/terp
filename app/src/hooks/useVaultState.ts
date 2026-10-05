"use client";

import { PublicKey } from "@solana/web3.js";
import type { Launch, VaultState } from "@terp/sdk";
import { useAsync, type AsyncState } from "./useAsync";
import { useClient, useSimulationPayer } from "./useClient";

/**
 * One snapshot of a vault, optionally refreshed every `intervalMs`. Given a mint, the launch
 * account is re-read on every refresh so its counters stay current; `null` means the mint has no
 * launch. Given a launch that was just fetched, it is used as is.
 */
export function useVaultState(source: Launch | PublicKey, intervalMs?: number): AsyncState<VaultState | null> {
  const client = useClient();
  const payer = useSimulationPayer();
  const mint = source instanceof PublicKey ? source : source.mint;
  return useAsync(
    async () => {
      const launch = source instanceof PublicKey ? await client.fetchLaunch(source) : source;
      return launch && payer ? client.fetchVaultState(launch, payer) : null;
    },
    payer ? `${mint.toBase58()}:${payer.toBase58()}` : null,
    intervalMs,
  );
}
