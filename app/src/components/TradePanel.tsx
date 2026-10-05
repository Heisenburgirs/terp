"use client";

import { calculateTransferFeeIncludedAmount } from "@meteora-ag/dlmm";
import { useWallet } from "@solana/wallet-adapter-react";
import { SLOT_MS, USDC_DECIMALS, USDC_MINT, math, type Launch } from "@terp/sdk";
import BN from "bn.js";
import { useState } from "react";
import { useAsync, type AsyncState } from "@/hooks/useAsync";
import { useSendTx } from "@/hooks/useSendTx";
import type { Balances, Market } from "@/lib/chain";
import { formatActivation, formatAtoms, formatBps, formatPrice, parseAtoms } from "@/lib/format";
import { Notice, Panel, Rows } from "./ui";

const toBig = (value: BN) => BigInt(value.toString());

interface Props {
  launch: Launch;
  symbol: string;
  market: AsyncState<Market>;
  balances: AsyncState<Balances>;
  onDone: () => void;
}

export function TradePanel({ launch, symbol, market, balances, onDone }: Props) {
  const { publicKey } = useWallet();
  const sendTx = useSendTx();
  // set once a trade of this session has confirmed; only ever a note, nothing is sent
  const [traded, setTraded] = useState(false);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amountText, setAmountText] = useState("");
  const [slippageText, setSlippageText] = useState("1");

  const buying = side === "buy";
  const input = buying ? { symbol: "USDC", decimals: USDC_DECIMALS } : { symbol, decimals: launch.decimals };
  const output = buying ? { symbol, decimals: launch.decimals } : { symbol: "USDC", decimals: USDC_DECIMALS };
  const amount = parseAtoms(amountText, input.decimals);
  const slippageBps = parseAtoms(slippageText, 2);
  const slippageOk = slippageBps !== null && slippageBps <= 5000n;
  const balance = balances.data && (buying ? balances.data.usdc : balances.data.token);
  // a pool is created before it trades: swaps are rejected until its activation point
  const activation = market.data?.activation;
  const notOpen = !!activation && !activation.open;

  // re-quoted every 10s against the pool state fetched by the page
  const quoted = useAsync(
    async () => {
      const { dlmm, tokenIsX } = market.data!;
      // "swap for Y" means selling the pool's X token
      const swapForY = buying ? !tokenIsX : tokenIsX;
      const binArrays = await dlmm.getBinArrayForSwap(swapForY);
      const quote = dlmm.swapQuote(new BN(amount!.toString()), swapForY, new BN(slippageBps!.toString()), binArrays);
      const out = toBig(quote.outAmount);
      // the quote is already net of the token's transfer fee on whichever leg carries the token
      const transferFee = buying
        ? toBig(
            calculateTransferFeeIncludedAmount(
              quote.outAmount,
              tokenIsX ? dlmm.tokenX.mint : dlmm.tokenY.mint,
              dlmm.clock.epoch.toNumber(),
            ).amount,
          ) - out
        : math.transferFee(amount!, launch.transferFeeBps);
      return { quote, out, transferFee };
    },
    market.data && !notOpen && amount && amount > 0n && slippageOk ? `${side}:${amount}:${slippageBps}` : null,
    10_000,
  );

  const submit = async () => {
    if (!publicKey || !market.data || !quoted.data || !amount || notOpen) return;
    const { dlmm } = market.data;
    const { quote, out, transferFee } = quoted.data;
    setTraded(false);
    const signature = await sendTx({
      title: `${buying ? "Buy" : "Sell"} ${symbol}`,
      rows: [
        ["You pay", `${formatAtoms(amount, input.decimals)} ${input.symbol}`],
        ["Expected to receive", `${formatAtoms(out, output.decimals)} ${output.symbol}`],
        ["Minimum received", `${formatAtoms(toBig(quote.minOutAmount), output.decimals)} ${output.symbol}`],
        [
          `${formatBps(launch.transferFeeBps)} transfer tax, to this token's vault`,
          `${formatAtoms(transferFee, launch.decimals)} ${symbol}`,
        ],
        ["Pool", dlmm.pubkey.toBase58()],
      ],
      notes: ["A swap on the launch's Meteora DLMM pool. It reverts if you would receive less than the minimum."],
      build: async () => {
        const transaction = await dlmm.swap({
          inToken: buying ? USDC_MINT : launch.mint,
          outToken: buying ? launch.mint : USDC_MINT,
          inAmount: new BN(amount.toString()),
          minOutAmount: quote.minOutAmount,
          lbPair: dlmm.pubkey,
          user: publicKey,
          binArraysPubkey: quote.binArraysPubkey,
        });
        return { instructions: transaction.instructions };
      },
    });
    if (signature) {
      setAmountText("");
      onDone();
      setTraded(true);
    }
  };

  if (!launch.pool) {
    return (
      <Panel title="Trade">
        <Notice title="No pool yet">
          <p>The creator has not registered a liquidity pool for this launch, so it cannot be traded here.</p>
        </Notice>
      </Panel>
    );
  }

  const data = quoted.data;
  const usdcAtoms = data && amount ? (buying ? amount : data.out) : null;
  const tokenAtoms = data && amount ? (buying ? data.out : amount) : null;
  const averagePrice =
    usdcAtoms !== null && tokenAtoms
      ? Number(usdcAtoms) / 10 ** USDC_DECIMALS / (Number(tokenAtoms) / 10 ** launch.decimals)
      : null;

  return (
    <Panel title="Trade" aside="Meteora DLMM">
      <div className="tabs" role="tablist" aria-label="Trade side">
        {(["buy", "sell"] as const).map((option) => (
          <button key={option} role="tab" aria-selected={side === option} onClick={() => setSide(option)}>
            {option === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <label>
        <span>
          Amount ({input.symbol})
          {balance !== undefined && (
            <small> balance {formatAtoms(balance, input.decimals)}</small>
          )}
        </span>
        <input
          inputMode="decimal"
          placeholder="0.0"
          value={amountText}
          onChange={(event) => setAmountText(event.target.value)}
        />
      </label>
      <label>
        <span>Slippage tolerance (%)</span>
        <input inputMode="decimal" value={slippageText} onChange={(event) => setSlippageText(event.target.value)} />
      </label>

      {market.error && !market.data && <Notice tone="bad" title="Pool unavailable"><p>{market.error}</p></Notice>}
      {notOpen && activation && (
        <Notice tone="warn" title={`Trading opens at ${formatActivation(activation, SLOT_MS)}`}>
          <p>
            The pool exists but has not been activated yet, so swaps are rejected until then. The creator uses this
            window to seed the pool&apos;s liquidity.
          </p>
        </Notice>
      )}
      {amountText && amount === null && <p className="bad small">Enter a valid amount.</p>}
      {!slippageOk && <p className="bad small">Slippage must be between 0 and 50%.</p>}
      {quoted.error && <Notice tone="bad" title="No quote"><p>{quoted.error}</p></Notice>}

      {data && amount && (
        <Rows
          rows={[
            ["You pay", `${formatAtoms(amount, input.decimals)} ${input.symbol}`],
            [
              "Pool swap fee",
              `${formatAtoms(toBig(data.quote.fee), data.quote.feeOnInput ? input.decimals : output.decimals)} ${
                data.quote.feeOnInput ? input.symbol : output.symbol
              }`,
              "included in the quote",
            ],
            [
              `${formatBps(launch.transferFeeBps)} transfer tax`,
              `${formatAtoms(data.transferFee, launch.decimals)} ${symbol}`,
              buying
                ? "withheld from the tokens the pool sends you; goes to this token's vault"
                : "withheld from the tokens you send; goes to this token's vault",
            ],
            ["You receive (expected)", `${formatAtoms(data.out, output.decimals)} ${output.symbol}`, "after all fees"],
            ["Minimum received", `${formatAtoms(toBig(data.quote.minOutAmount), output.decimals)} ${output.symbol}`],
            ["Average price", averagePrice === null ? "n/a" : formatPrice(averagePrice), "USDC per token, after fees"],
            ["Price impact", `${data.quote.priceImpact.toFixed(2)}%`],
          ]}
        />
      )}

      <p className="muted small">
        Every transfer of this token pays its permanent {formatBps(launch.transferFeeBps)} Token-2022 transfer tax,
        buys and sells included. The quote comes from the Meteora SDK, which already deducts the tax; it is shown above
        so you can see it. The withheld tokens go to this token&apos;s vault, not to the creator or an operator
        wallet. When the vault sells them, {formatBps(launch.keeperFeeBps)} of the USDC is paid to the platform as the
        keeper fee and the rest stays in the vault.
      </p>

      {data && (
        <p className="muted small">
          The pool swap fee is not flat: Meteora raises it with the number of price bins a swap crosses, so a large
          trade in a thin pool pays far more than the base fee. The figure above is what this trade pays. It goes to
          the pool&apos;s liquidity positions.
        </p>
      )}

      <button className="primary" disabled={!publicKey || !data || quoted.loading || notOpen} onClick={submit}>
        {notOpen ? "Trading has not opened" : publicKey ? `Review ${buying ? "buy" : "sell"}` : "Connect a wallet to trade"}
      </button>

      {traded && (
        <p className="muted small">
          The tax withheld from this trade will be swept, sold and deployed by the Terp keeper. There is nothing for
          you to click.
        </p>
      )}
    </Panel>
  );
}
