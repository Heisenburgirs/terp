"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND, TAGLINE } from "@/lib/brand";
import { CLUSTER } from "@/lib/env";

// the wallet button reads browser-only state; rendering it on the server would mismatch
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((module) => module.WalletMultiButton),
  { ssr: false },
);

/** The wordmark: lowercase "terp" set in the display face, closed by a dot in the accent colour. */
export function Wordmark() {
  return (
    <Link href="/" className="brand" aria-label={`${BRAND} home`}>
      <span>terp</span>
      <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <circle cx="5" cy="5" r="5" />
      </svg>
    </Link>
  );
}

export function Header({ wallet }: { wallet?: boolean }) {
  const pathname = usePathname();
  const current = (href: string) => (pathname === href ? "page" : undefined);

  return (
    <header className="site">
      <div className="inner">
        <Wordmark />
        <span className="tagline">{TAGLINE}</span>
        <nav aria-label="Main">
          <Link href="/launches" aria-current={current("/launches")}>
            Launches
          </Link>
          <Link href="/create" aria-current={current("/create")}>
            Create
          </Link>
        </nav>
        <span className="badge" title="Solana cluster this app reads from">
          {CLUSTER}
        </span>
        {wallet && <WalletMultiButton />}
      </div>
    </header>
  );
}
