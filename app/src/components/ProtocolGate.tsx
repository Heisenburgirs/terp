"use client";

import type { ReactNode } from "react";
import { useProtocol } from "@/hooks/useClient";
import { CLUSTER, PROGRAM_ID } from "@/lib/env";
import { Address, Notice } from "./ui";

/** Renders its children only once the protocol config account has been read from the cluster. */
export function ProtocolGate({ children }: { children: ReactNode }) {
  const protocol = useProtocol();

  if (protocol.status === "loading") return <p className="muted">Checking the protocol deployment…</p>;

  if (protocol.status === "not-deployed") {
    return (
      <Notice tone="warn" title="Protocol not deployed on this cluster">
        <p>
          No protocol config account exists for program <Address value={PROGRAM_ID} full /> on {CLUSTER}. The program
          has not been deployed or initialised here, so there are no launches, vaults or prices to show.
        </p>
        {protocol.browserError && (
          <p className="small">
            That was checked by the server. This browser could not reach the RPC endpoint itself ({protocol.browserError});
            public endpoints often reject browser requests, so use a dedicated one.
          </p>
        )}
        <p className="muted small">
          Nothing on this site is sample data. Once the program is deployed and configured, launches appear here
          straight from chain.
        </p>
      </Notice>
    );
  }

  if (protocol.status === "error") {
    return (
      <Notice tone="bad" title="Could not reach the cluster">
        <p>{protocol.error}</p>
        <p className="muted small">
          Check NEXT_PUBLIC_RPC_URL. Public endpoints often reject browser requests or rate-limit them.
        </p>
        <button onClick={protocol.retry}>Retry</button>
      </Notice>
    );
  }

  return (
    <>
      {protocol.config.paused && (
        <Notice tone="warn" title="Protocol paused">
          <p>The admin has paused risk-increasing actions, including new launches.</p>
        </Notice>
      )}
      {children}
    </>
  );
}
