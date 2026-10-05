"use client";

import { Suspense } from "react";
import { CreateFlow } from "@/components/CreateFlow";
import { ProtocolGate } from "@/components/ProtocolGate";

export default function CreatePage() {
  return (
    <>
      <h1>Create a launch</h1>
      <p className="lead">
        A launch is a fixed-supply token with a transfer tax of 1% or 3%, a token/USDC pool on Meteora DLMM, and its
        own vault that levers the tax into a long on one asset. You choose the tax rate and the asset here; both are
        permanent. Creation takes four transactions. Nothing is sent until you review it here and approve it in your
        wallet.
      </p>
      <ProtocolGate>
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <CreateFlow />
        </Suspense>
      </ProtocolGate>
    </>
  );
}
