import type { Metadata } from "next";
import type { ReactNode } from "react";

// the page itself is a client component, so its title is set here
export const metadata: Metadata = { title: "Launches" };

export default function LaunchesLayout({ children }: { children: ReactNode }) {
  return children;
}
