"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { useMemo, type ReactNode } from "react";
import { ClientProvider } from "@/hooks/useClient";
import { SendTxProvider } from "@/hooks/useSendTx";
import { ENV_ERROR, RPC_URL } from "@/lib/env";
import { Header } from "./Header";
import { Notice } from "./ui";

export function Providers({ serverSawConfig, children }: { serverSawConfig: boolean | null; children: ReactNode }) {
  // wallets implementing the Wallet Standard are detected on their own; these cover the rest
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  if (ENV_ERROR) {
    return (
      <>
        <Header />
        <main>
          <Notice tone="warn" title="Not configured">
            <p>
              {ENV_ERROR} Copy <code>.env.example</code> to <code>.env.local</code>, set the RPC endpoint and restart.
              No on-chain data can be shown until then.
            </p>
          </Notice>
        </main>
      </>
    );
  }

  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ClientProvider serverSawConfig={serverSawConfig}>
            <SendTxProvider>
              <Header wallet />
              <main>{children}</main>
            </SendTxProvider>
          </ClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
