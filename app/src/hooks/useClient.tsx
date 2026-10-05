"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TerpClient, type ProtocolConfig } from "@terp/sdk";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { PROGRAM_ID } from "@/lib/env";
import { useAsync } from "./useAsync";

export type Protocol =
  | { status: "loading" }
  | { status: "not-deployed"; browserError?: string }
  | { status: "error"; error: string; retry: () => void }
  | { status: "ready"; config: ProtocolConfig };

const ClientContext = createContext<{ client: TerpClient; protocol: Protocol } | null>(null);

/**
 * Owns the one read-only SDK client and the protocol config lookup. `serverSawConfig` is the
 * server's own check of the config account, so the first paint already shows the right state.
 */
export function ClientProvider({ serverSawConfig, children }: { serverSawConfig: boolean | null; children: ReactNode }) {
  const { connection } = useConnection();
  const client = useMemo(() => new TerpClient(connection, PROGRAM_ID), [connection]);
  const config = useAsync(() => client.fetchConfig(), connection.rpcEndpoint);

  const protocol: Protocol = config.data
    ? { status: "ready", config: config.data }
    : config.error && serverSawConfig === false
      ? // the server reached the RPC and found no config account, even though this browser cannot
        { status: "not-deployed", browserError: config.error }
      : config.error
        ? { status: "error", error: config.error, retry: config.reload }
        : config.data === null || serverSawConfig === false
          ? { status: "not-deployed" }
          : { status: "loading" };

  const value = useMemo(() => ({ client, protocol }), [client, protocol.status, config.data, config.error]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

function useClientContext() {
  const context = useContext(ClientContext);
  if (!context) throw new Error("ClientProvider is missing");
  return context;
}

/** The SDK client. It reads state and builds instructions; it never signs or sends. */
export function useClient(): TerpClient {
  return useClientContext().client;
}

export function useProtocol(): Protocol {
  return useClientContext().protocol;
}

/**
 * An existing funded account for simulating Phoenix's read-only views: the connected wallet,
 * otherwise the protocol treasury. Nothing is signed with it.
 */
export function useSimulationPayer(): PublicKey | null {
  const { publicKey } = useWallet();
  const protocol = useProtocol();
  return publicKey ?? (protocol.status === "ready" ? protocol.config.treasury : null);
}
