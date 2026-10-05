import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./landing.css";

const DESCRIPTION =
  "Terp is a token launchpad in development. Every token's transfer tax funds a leveraged perp position " +
  "held by that token's own on-chain vault, and holders can burn tokens to redeem their share of it. Not live.";

export const metadata: Metadata = {
  title: { absolute: "Terp — transfer tax that funds a perp position" },
  description: DESCRIPTION,
};

/** Small line drawings for the four steps. Decorative: the step names carry the meaning. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg className="glyph" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const STEPS: { name: string; text: string; tag: string; glyph: ReactNode }[] = [
  {
    name: "Trade",
    text: "Every transfer of a Terp token pays a small tax: 1% or 3%, fixed forever when the token is created.",
    tag: "1% or 3% per transfer",
    glyph: (
      <>
        <path d="M8 17h31M32 10l7 7-7 7" />
        <path d="M40 31H9M16 24l-7 7 7 7" />
      </>
    ),
  },
  {
    name: "Fund",
    text: "The tax is sold for USDC and goes to that token's own on-chain vault. No creator or operator account sits in the middle.",
    tag: "tax → USDC → vault",
    glyph: (
      <>
        <path d="M24 5v22M17 20l7 7 7-7" />
        <path d="M15 22H9v20h30V22h-6" />
      </>
    ),
  },
  {
    name: "Lever",
    text: "The vault holds a perpetual long on SOL, BTC or another listed asset on Phoenix, kept close to 5x. Tax adds margin, and the position is topped up or trimmed to stay in its band.",
    tag: "perp long · close to 5x",
    glyph: (
      <>
        <path d="M5 12h38M5 36h38" strokeDasharray="3 4" />
        <path d="M6 31l10-8 8 5 10-11 8 3" />
      </>
    ),
  },
  {
    name: "Redeem",
    text: "Burn tokens at any time to take your pro-rata share of the vault's equity in USDC.",
    tag: "burn → USDC, pro rata",
    glyph: (
      <>
        <circle cx="15" cy="24" r="9" />
        <path d="M28 24h14M35 17l7 7-7 7" />
      </>
    ),
  },
];

const DIFFERENCES: { title: string; text: string }[] = [
  {
    title: "One vault per token",
    text: "Each token has its own vault, and its tax can only go there. Not to the creator, not to the operator, not to another token.",
  },
  {
    title: "Liquidity that launches locked",
    text: "Each token starts with a tokens-only pool on Meteora DLMM. The liquidity positions are owned by the vault, not by the creator.",
  },
  {
    title: "Rules enforced by the program",
    text: "The operator's keeper can trigger each step. It cannot choose amounts, prices or destinations, and it cannot withdraw.",
  },
  {
    title: "Transfers maintain the position",
    text: "A Token-2022 transfer hook nudges the vault to rebalance as the token is traded, so ordinary trading keeps the position in its band. This is part of the design and still in development.",
  },
];

const RISKS: { title: string; text: string }[] = [
  {
    title: "Leverage can be liquidated",
    text: "The position is leveraged. A sharp move against it can liquidate it, and a token's backing can go to zero.",
  },
  {
    title: "A profitable position is not a profitable token",
    text: "Market price can sit above or below redemption value. The vault can gain while buyers of the token lose.",
  },
  {
    title: "Unaudited and in development",
    text: "The program has not been audited and is still being built. It may contain bugs.",
  },
  {
    title: "Depends on Phoenix and Meteora",
    text: "The position lives on Phoenix and the pool on Meteora. A failure or change in either can affect the vault.",
  },
];

export default function LandingPage() {
  return (
    <>
      <main className="landing">
        <section className="hero" aria-labelledby="terp">
          <div className="wrap">
            <p className="chip">
              <span className="chip-dot" aria-hidden="true" />
              In development · not live
            </p>
            <h1 id="terp">
              Terp
              <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
                <circle cx="5" cy="5" r="5" />
              </svg>
            </h1>
            <p className="idea">
              A token launchpad where every token&apos;s transfer tax funds a leveraged perp position that its holders
              own.
            </p>
            <p className="sub">
              The tax goes to a vault that belongs to the token, not to a creator or an operator. Holders can burn
              their tokens for a share of it at any time.
            </p>
            <p className="jump">
              <a href="#how-it-works">How it works</a>
            </p>
          </div>
        </section>

        <section className="band" id="how-it-works" aria-labelledby="how-title">
          <div className="wrap">
            <p className="label">How it works</p>
            <h2 id="how-title">Four steps, repeated with every trade.</h2>
            <ol className="flow">
              {STEPS.map((step, index) => (
                <li key={step.name}>
                  <span className="node" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="step-body">
                    <Glyph>{step.glyph}</Glyph>
                    <h3>{step.name}</h3>
                    <p>{step.text}</p>
                    <p className="tag">{step.tag}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="loop">The next transfer starts it again.</p>
          </div>
        </section>

        <section className="block" aria-labelledby="different-title">
          <div className="wrap">
            <p className="label">What makes it different</p>
            <h2 id="different-title">Built so the tax has one place to go.</h2>
            <ul className="points">
              {DIFFERENCES.map((point) => (
                <li key={point.title}>
                  <h3>{point.title}</h3>
                  <p>{point.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="block ruled" aria-labelledby="money-title">
          <div className="wrap">
            <p className="label">How the money moves</p>
            <h2 id="money-title">Where the tax goes, and what comes back.</h2>
            <div className="split" role="img" aria-label="Of each tax sale, 97% goes to the token's vault and 3% to the platform.">
              <span className="to-vault">97%</span>
              <span className="to-platform" />
            </div>
            <div className="split-key" aria-hidden="true">
              <span>to the token&apos;s vault</span>
              <span>3% to the platform</span>
            </div>
            <dl className="money">
              <div>
                <dt>Each tax sale</dt>
                <dd className="figure">97 / 3</dd>
                <dd>97% of the USDC goes to the token&apos;s vault. 3% goes to the platform.</dd>
              </div>
              <div>
                <dt>Redemption</dt>
                <dd className="figure">pro rata − 3%</dd>
                <dd>
                  You receive your pro-rata share of the vault&apos;s equity, less a 3% fee. The fee stays in the vault
                  with the remaining holders.
                </dd>
              </div>
              <div>
                <dt>Pool swap fees</dt>
                <dd className="figure">→ vault</dd>
                <dd>Fees earned by the token&apos;s pool also flow to its vault.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="block risk" aria-labelledby="risk-title">
          <div className="wrap">
            <p className="label">The risks, plainly</p>
            <h2 id="risk-title">You can lose everything you put in.</h2>
            <ul className="points">
              {RISKS.map((risk) => (
                <li key={risk.title}>
                  <h3>{risk.title}</h3>
                  <p>{risk.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <div className="wrap">
          <p>Terp — in development. Nothing here is an offer or financial advice.</p>
          <p className="stack">Built on Solana · Token-2022 · Meteora DLMM · Phoenix perps</p>
        </div>
      </footer>
    </>
  );
}
