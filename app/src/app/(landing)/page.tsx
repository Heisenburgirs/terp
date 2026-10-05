import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import "./landing.css";

const DESCRIPTION =
  "Terp is a token launchpad in development. Each token's transfer tax is sold for USDC and funds a leveraged " +
  "perp long held by that token's own on-chain vault. The token's own transfers keep the position maintained, " +
  "with no keeper and no operator key, and holders can burn tokens to redeem their share. Not live.";

export const metadata: Metadata = {
  title: { absolute: "Terp — a transfer tax that funds a perp position nobody runs" },
  description: DESCRIPTION,
};

/** The four stages. Each has one pad colour, used for its key on the device and its deck below. */
const STEPS: { name: string; tone: string; text: ReactNode; tag: string }[] = [
  {
    name: "Trade",
    tone: "amber",
    text: (
      <>
        Every transfer of a Terp token pays a small tax: 1% or 3%, fixed forever when the token is created. The token
        itself holds it back; nobody collects it by hand.
      </>
    ),
    tag: "1% or 3% per transfer",
  },
  {
    name: "Fund",
    tone: "green",
    text: (
      <>
        The tax is sold for USDC and goes to that token&apos;s own on-chain vault. No creator or operator account sits
        in the middle.
      </>
    ),
    tag: "tax → USDC → vault",
  },
  {
    name: "Lever",
    tone: "violet",
    text: (
      <>
        The vault holds a perpetual long (SOL, BTC or another listed asset) on Phoenix, kept close to 5x.{" "}
        <strong>The token&apos;s own transfers do the upkeep</strong>: each transfer calls the vault, which checks the
        position and opens, tops up or trims it when its rules say so, and does nothing otherwise.
      </>
    ),
    tag: "perp long · close to 5x",
  },
  {
    name: "Redeem",
    tone: "blue",
    text: <>Burn tokens at any time to take your pro-rata share of the vault&apos;s equity in USDC.</>,
    tag: "burn → USDC, pro rata",
  },
];

const NOBODY: { title: string; text: string }[] = [
  {
    title: "No keeper, no operator key",
    text: "The token's transfers maintain the position. The one step a transfer cannot do, swapping collected tax to USDC, rides along with ordinary trades and can be triggered by anyone.",
  },
  {
    title: "One vault per token",
    text: "Each token has its own vault, and its tax can only go there.",
  },
  {
    title: "Liquidity launches locked",
    text: "Each token starts with a tokens-only pool on Meteora DLMM. The liquidity positions are owned by the vault.",
  },
  {
    title: "The program sets the terms",
    text: "Every amount, price and destination is set by the program, never by whoever triggers a step.",
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
  {
    title: "Pools need Meteora's approval",
    text: "Tokens that use the transfer-driven upkeep need Meteora to approve them before they can have a pool.",
  },
];

/*
 * The hero board, 8 by 8, top row first. Two columns per stage, left to right, under that stage's key:
 *   w  a transfer (white)            columns 1-2  TRADE
 *   a  tax held back (amber)
 *   g  USDC in the vault (green)     columns 3-4  FUND
 *   v  the position (violet)         columns 5-6  LEVER
 *   b  a redemption (blue)           columns 7-8  REDEEM
 *   .  an unlit pad
 * landing.css lights each group in turn; without motion the whole arrangement is simply lit.
 */
const BOARD = [
  "........",
  "w.......",
  ".a......",
  "wa..vv..",
  "wa..vv..",
  ".aggvv..",
  "waggvvb.",
  "waggvvbb",
];
const PAD_CLASS: Record<string, string> = { w: "white", a: "amber", g: "green", v: "violet", b: "blue" };

/** The white pads blink out of step, like transfers arriving: board row -> place in the order. */
const WHITE_ORDER: Record<number, number> = { 1: 0, 3: 3, 4: 1, 6: 4, 7: 2 };

/** Where a pad falls in its group's lighting order: stacks fill from the bottom row up. */
function padOrder(kind: string, row: number, col: number): number {
  const fromBottom = BOARD.length - 1 - row;
  if (kind === "g") return fromBottom * 2 + (col - 2);
  if (kind === "b") return row === 7 ? col - 6 : 2;
  if (kind === "w") return WHITE_ORDER[row] ?? 0;
  return fromBottom;
}

function Diamond() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M5 0.6 9.4 5 5 9.4 0.6 5Z" />
    </svg>
  );
}

/** The device: a slab, four stage keys along the top, eight scene keys down the right, 64 pads. */
function Device() {
  return (
    <div className="device-wrap">
      <div
        className="device"
        role="img"
        aria-label="A grid controller showing the flow from left to right: transfers and the tax they pay, the tax becoming USDC in the vault, the leveraged position growing, and a redemption."
      >
        {STEPS.map((step, index) => (
          <span key={step.name} className={`stage-key ${step.tone}`} style={{ "--s": index } as CSSProperties}>
            <span>{step.name}</span>
          </span>
        ))}
        <span className="logo-key">
          <Diamond />
        </span>
        {BOARD.map((line, row) => (
          <span className="pad-row" key={row}>
            {[...line].map((kind, col) =>
              kind === "." ? (
                <span className="pad" key={col} />
              ) : (
                <span
                  className={`pad lit ${PAD_CLASS[kind]}`}
                  key={col}
                  style={{ "--n": padOrder(kind, row, col) } as CSSProperties}
                />
              ),
            )}
            <span className="side-key">
              <svg viewBox="0 0 10 10" focusable="false">
                <path d="M3.5 2 6.8 5 3.5 8" />
              </svg>
            </span>
          </span>
        ))}
      </div>
      <ul className="legend" aria-label="What the pad colours mean">
        <li className="white">transfer</li>
        <li className="amber">tax</li>
        <li className="green">USDC in vault</li>
        <li className="violet">position</li>
        <li className="blue">redemption</li>
      </ul>
    </div>
  );
}

/** 100 small pads: 97 lit green for the vault, 3 white for the platform. */
function Split() {
  return (
    <div
      className="split"
      role="img"
      aria-label="Of each tax sale, 97% goes to the token's vault and 3% to the platform."
    >
      {Array.from({ length: 100 }, (_, index) => (
        <span key={index} className={index < 97 ? "green" : "white"} />
      ))}
    </div>
  );
}

export default function LandingPage() {
  return (
    <>
      <header className="landing-top">
        <div className="wrap">
          <a className="brand" href="#terp" aria-label="Terp, top of page">
            <span className="logo-key" aria-hidden="true">
              <Diamond />
            </span>
            <span>terp</span>
          </a>
          <nav aria-label="On this page">
            <a href="#how-it-works">Steps</a>
            <a href="#nobody-runs-it">Upkeep</a>
            <a href="#money">Money</a>
            <a href="#risks">Risks</a>
          </nav>
        </div>
      </header>

      <main className="landing">
        <section className="hero" aria-labelledby="terp">
          <div className="wrap">
            <div className="hero-text">
              <p className="status-key">In development · not live</p>
              <h1 id="terp">Terp</h1>
              <p className="idea">
                A token launchpad where every transfer funds a leveraged position, and keeps it running.
              </p>
              <p className="sub">
                Each token&apos;s transfer tax goes to a vault that belongs to the token, not to a creator or an
                operator. The vault holds a perp long, the token&apos;s own transfers do the upkeep, and holders can
                burn their tokens for a share of it at any time.
              </p>
              <p className="jump">
                <a href="#how-it-works">
                  How it works
                  <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
                    <path d="M2 3.5 5 6.8 8 3.5" />
                  </svg>
                </a>
              </p>
            </div>
            <Device />
          </div>
        </section>

        <section className="block" id="how-it-works" aria-labelledby="how-title">
          <div className="wrap">
            <p className="label">The idea in four steps</p>
            <h2 id="how-title">Four steps, repeated with every transfer.</h2>
            <ol className="flow">
              {STEPS.map((step, index) => (
                <li key={step.name} className={step.tone}>
                  <div className="step-head">
                    <span className="pad" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3>{step.name}</h3>
                  </div>
                  <p>{step.text}</p>
                  <p className="tag">{step.tag}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="block" id="nobody-runs-it" aria-labelledby="nobody-title">
          <div className="wrap">
            <p className="label">Nobody runs it</p>
            <h2 id="nobody-title">No keeper. No operator key. The token does the work.</h2>
            <ul className="points">
              {NOBODY.map((point) => (
                <li key={point.title}>
                  <h3>{point.title}</h3>
                  <p>{point.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="block" id="money" aria-labelledby="money-title">
          <div className="wrap">
            <p className="label">How the money moves</p>
            <h2 id="money-title">Where the tax goes, and what comes back.</h2>
            <div className="split-deck">
              <Split />
              <dl className="split-key">
                <div className="green">
                  <dt>97%</dt>
                  <dd>of each tax sale goes to the token&apos;s vault</dd>
                </div>
                <div className="white">
                  <dt>3%</dt>
                  <dd>goes to the platform</dd>
                </div>
              </dl>
            </div>
            <dl className="money">
              <div className="green">
                <dt>Each tax sale</dt>
                <dd className="figure">97 / 3</dd>
                <dd>97% of the USDC goes to the token&apos;s vault. 3% goes to the platform.</dd>
              </div>
              <div className="blue">
                <dt>Redemption</dt>
                <dd className="figure">pro rata − 3%</dd>
                <dd>
                  You receive your pro-rata share of the vault&apos;s equity, less a 3% fee. The fee stays in the vault
                  with the remaining holders.
                </dd>
              </div>
              <div className="green">
                <dt>Pool swap fees</dt>
                <dd className="figure">→ vault</dd>
                <dd>Fees earned by the token&apos;s pool also flow to its vault.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="block risk" id="risks" aria-labelledby="risk-title">
          <div className="wrap">
            <p className="label">The risks, plainly</p>
            <h2 id="risk-title">You can lose everything you put in.</h2>
            <ul className="risk-list">
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
