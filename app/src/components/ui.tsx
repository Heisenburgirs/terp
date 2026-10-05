import type { PublicKey } from "@solana/web3.js";
import type { RiskStatus } from "@terp/sdk";
import type { ReactNode } from "react";
import { explorerUrl } from "@/lib/env";
import { formatLeverage, shortKey, type LeveragePolicy } from "@/lib/format";

export function Panel({
  title,
  aside,
  id,
  children,
}: {
  title: string;
  aside?: ReactNode;
  /** Anchor other parts of the page can link to. */
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel" id={id}>
      <header>
        <h2>{title}</h2>
        {aside && <span className="muted small">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

export function Notice({ tone, title, children }: { tone?: "warn" | "bad"; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice ${tone ?? ""}`}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

/** A labelled list of figures. `rows` are `[label, value, hint?]`. */
export function Rows({ rows }: { rows: [label: string, value: ReactNode, hint?: string][] }) {
  return (
    <dl className="rows">
      {rows.map(([label, value, hint]) => (
        <div key={label}>
          <dt>
            {label}
            {hint && <small>{hint}</small>}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Address({ value, full }: { value: PublicKey | string; full?: boolean }) {
  const text = typeof value === "string" ? value : value.toBase58();
  return (
    <a className="mono" href={explorerUrl("address", text)} target="_blank" rel="noreferrer" title={text}>
      {full ? text : shortKey(text)}
    </a>
  );
}

const RISK: Record<RiskStatus, { label: string; tone: string; meaning: (policy: LeveragePolicy) => string }> = {
  "no-position": {
    label: "No position",
    tone: "",
    meaning: (policy) =>
      `The vault holds no perp exposure right now. Once it has collateral, the next rebalance opens the position at ${formatLeverage(policy.targetLeverageBps)}.`,
  },
  healthy: {
    label: "Healthy",
    tone: "good",
    meaning: (policy) =>
      `Leverage is at or under the ${formatLeverage(policy.targetLeverageBps)} target. If it is under ${formatLeverage(policy.minLeverageBps)} after the next deposit, that deployment buys exposure back up to ${formatLeverage(policy.targetLeverageBps)}, in profit or not; between ${formatLeverage(policy.minLeverageBps)} and ${formatLeverage(policy.targetLeverageBps)} nothing is traded.`,
  },
  "above-target": {
    label: "Above target",
    tone: "warn",
    meaning: (policy) =>
      `Leverage is above the ${formatLeverage(policy.targetLeverageBps)} target, usually after the asset fell. New tax only adds collateral, which pulls leverage back down; nothing is cut unless leverage goes above ${formatLeverage(policy.maxLeverageBps)}.`,
  },
  deleverage: {
    label: "Deleverage",
    tone: "bad",
    meaning: (policy) =>
      `Leverage is above the ${formatLeverage(policy.maxLeverageBps)} maximum; any wallet may send the deleverage instruction, which cuts the position to ${formatLeverage(policy.deleverageToBps)} and realises the loss on the part it closes.`,
  },
  liquidatable: {
    label: "Liquidatable",
    tone: "bad",
    meaning: () => "Phoenix may liquidate the position. Backing can be lost. Any wallet may send the deleverage instruction.",
  },
};

export function RiskBadge({ risk, policy }: { risk: RiskStatus; policy: LeveragePolicy }) {
  const { label, tone, meaning } = RISK[risk];
  return (
    <span className={`badge ${tone}`} title={meaning(policy)}>
      {label}
    </span>
  );
}

export const riskMeaning = (risk: RiskStatus, policy: LeveragePolicy) => RISK[risk].meaning(policy);
