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

/** The logo key (a black diamond on a yellow pad) followed by lowercase "terp" in the display face. */
export function Wordmark() {
  return (
    <Link href="/" className="brand" aria-label={`${BRAND} home`}>
      <span className="logo-key" aria-hidden="true">
        <svg viewBox="0 0 10 10" focusable="false">
          <path d="M5 0.6 9.4 5 5 9.4 0.6 5Z" />
        </svg>
      </span>
      <span>terp</span>
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
