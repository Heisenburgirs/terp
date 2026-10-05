import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { TAGLINE } from "@/lib/brand";
import "./globals.css";

// The only two families: a grotesque for words, a monospace for figures, captions and key labels.
const sans = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: `Terp: ${TAGLINE}`, template: "%s · Terp" },
  applicationName: "Terp",
};

// dark only: the browser chrome and form controls follow the slab
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "dark", themeColor: "#0b0b0d" };

/**
 * Document shell only: fonts and the shared theme. Nothing here touches a wallet or the RPC, so the
 * landing page in `(landing)` stays static. The app's providers, header and footer live in `(app)`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
