"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { fetchBalances, fetchMarket, fetchTokenMeta, fetchUpgradeAuthority, type Market } from "@/lib/chain";
import { PROGRAM_ID } from "@/lib/env";
import { fetchLiquidityLock } from "@/lib/liquidity";
import { useAsync } from "./useAsync";

export function useTokenMeta(mint: PublicKey) {
  const { connection } = useConnection();
  return useAsync(() => fetchTokenMeta(connection, mint), mint.toBase58());
}

/** The launch's DLMM pool and its active-bin price. Idle until the launch has a pool. */
export function useMarket(pool: PublicKey | null, mint: PublicKey, intervalMs?: number) {
  const { connection } = useConnection();
  return useAsync(() => fetchMarket(connection, pool!, mint), pool ? pool.toBase58() : null, intervalMs);
}

/** USDC and launch-token balances of `owner`, by default the connected wallet. Idle without an owner. */
export function useBalances(mint: PublicKey, intervalMs?: number, owner?: PublicKey) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const holder = owner ?? publicKey;
  return useAsync(
    () => fetchBalances(connection, holder!, mint),
    holder ? `${holder.toBase58()}:${mint.toBase58()}` : null,
    intervalMs,
  );
}

/**
 * The vault's positions in the launch pool and whether they are locked, decoded from chain.
 * Idle until the pool has been read. Reads with `getProgramAccounts`, so it is polled sparingly.
 */
export function useLiquidityLock(market: Market | undefined, launch: PublicKey | null, intervalMs?: number) {
  const { connection } = useConnection();
  return useAsync(
    () => fetchLiquidityLock(connection, market!, launch!),
    market && launch ? `lock:${market.dlmm.pubkey.toBase58()}:${launch.toBase58()}` : null,
    intervalMs,
  );
}

export function useUpgradeAuthority() {
  const { connection } = useConnection();
  return useAsync(() => fetchUpgradeAuthority(connection, PROGRAM_ID), PROGRAM_ID.toBase58());
}
