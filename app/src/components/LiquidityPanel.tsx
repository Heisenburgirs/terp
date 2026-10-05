"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { SLOT_MS, type Launch } from "@terp/sdk";
import type { AsyncState } from "@/hooks/useAsync";
import { useSendBatch } from "@/hooks/useSendTx";
import type { Market } from "@/lib/chain";
import { formatActivation, formatAtoms, formatBps, formatPrice, formatUsd } from "@/lib/format";
import { LOCK_NEVER, binPrice, buildClaimFees, type LiquidityLock } from "@/lib/liquidity";
import { Address, Notice, Panel, Rows } from "./ui";

/** One line for the lock status, and the tone it is shown in. Never says "locked" without the decoded positions. */
export function lockHeadline(lock: LiquidityLock): { label: string; tone: "good" | "bad" | ""; text: string } {
  if (lock.status === "locked") {
    return {
      label: "Locked",
      tone: "good",
      text: "Locked: positions are owned by the vault and can never be withdrawn.",
    };
  }
  if (lock.status === "none") return { label: "No liquidity yet", tone: "", text: "No liquidity yet." };
  return {
    label: "NOT locked",
    tone: "bad",
    text:
      lock.positions.length === 0
        ? "NOT locked: the pool holds liquidity, and none of it is in positions owned by the vault."
        : "NOT locked: the vault's positions do not all hold liquidity that can never be withdrawn.",
  };
}

interface Props {
  launch: Launch;
  symbol: string;
  market: AsyncState<Market>;
  lock: AsyncState<LiquidityLock>;
  onDone: () => void;
}

/** Who owns the pool's liquidity and where its swap fees go, read from the position accounts. */
export function LiquidityPanel({ launch, symbol, market, lock, onDone }: Props) {
  const { publicKey } = useWallet();
  const sendBatch = useSendBatch();
  const tokens = (amount: bigint) => `${formatAtoms(amount, launch.decimals)} ${symbol}`;

  if (!launch.pool) {
    return (
      <Panel title="Pool liquidity">
        <Notice title="No pool yet">
          <p>The creator has not registered a liquidity pool for this launch.</p>
        </Notice>
      </Panel>
    );
  }

  const data = lock.data;
  const pool = market.data;
  if (!data || !pool) {
    return (
      <Panel title="Pool liquidity">
        {lock.error || market.error ? (
          <Notice tone="bad" title="Lock status unknown">
            <p>
              The pool&apos;s positions could not be read, so nothing is claimed about them here: {lock.error ?? market.error}
            </p>
            <button onClick={lock.reload}>Retry</button>
          </Notice>
        ) : (
          <p className="muted">Reading the pool&apos;s positions…</p>
        )}
      </Panel>
    );
  }

  const headline = lockHeadline(data);
  const first = data.positions[0];
  const last = data.positions[data.positions.length - 1];
  const operators = [...new Set(data.positions.map((position) => position.operator.toBase58()))];
  const allNever = data.positions.every((position) => position.lockReleasePoint === LOCK_NEVER);
  const allVaultOwned = data.positions.every((position) => position.owner.equals(launch.address));
  const otherShare = data.tokenShareBps === null ? null : 10_000 - data.tokenShareBps;
  const hasFees = data.unclaimedUsdc > 0n || data.unclaimedTokens > 0n;
  // DLMM accepts a claim only from a position's operator: for a launch made here, the creator's wallet
  const canClaim = !!publicKey && (publicKey.equals(launch.creator) || operators.includes(publicKey.toBase58()));

  const claim = async () => {
    if (!publicKey) return;
    const confirmed = await sendBatch({
      title: "Claim pool fees into the vault",
      rows: [
        ["Unclaimed swap fees", formatUsd(data.unclaimedUsdc, 6) + (data.unclaimedTokens > 0n ? ` and ${tokens(data.unclaimedTokens)}` : "")],
        ["Paid to", `the vault's USDC account (${launch.vaultUsdc.toBase58()})`],
        ["You receive", "nothing; you pay the network fee"],
      ],
      notes: [
        "Meteora pays a position's fees only to its fee owner, which for these positions is the vault. A claim naming any other account is rejected by the DLMM program, and only the positions' operator (this wallet) can send one.",
        "Claimed USDC becomes idle USDC of the vault, so it counts in vault equity and is deployed by the keeper like converted tax. No keeper fee is taken from it.",
      ],
      build: () => buildClaimFees({ dlmm: pool.dlmm, positions: data.positions, sender: publicKey, vaultUsdc: launch.vaultUsdc }),
    });
    if (confirmed !== null) {
      lock.reload();
      onDone();
    }
  };

  return (
    <Panel title="Pool liquidity" aside="read from the pool's position accounts">
      <p>
        <span className={`badge ${headline.tone}`}>{headline.label}</span> {headline.text}
      </p>
      {data.status === "locked" && otherShare !== null && otherShare >= 100 && (
        <p className="warn small">
          The vault&apos;s locked positions hold {formatBps(data.tokenShareBps ?? 0)} of the pool&apos;s {symbol}. The
          other {formatBps(otherShare)} is outside the vault&apos;s positions: liquidity added by someone else is not
          locked and can be withdrawn by its owner.
        </p>
      )}
      {!pool.activation.open && (
        <Notice title="Trading has not opened">
          <p>Trading opens at {formatActivation(pool.activation, SLOT_MS)}. Until then nobody can swap in this pool.</p>
        </Notice>
      )}
      <Rows
        rows={[
          ["Positions owned by the vault", data.positions.length.toString(), "accounts of the Meteora DLMM program whose owner is this launch's vault"],
          ...(first && last
            ? ([
                [
                  "Price range they cover",
                  `${formatPrice(binPrice(pool, first.lowerBinId))} to ${formatPrice(binPrice(pool, last.upperBinId))}`,
                  `bins ${first.lowerBinId} to ${last.upperBinId}`,
                ],
                ["In those positions now", `${tokens(data.vaultTokens)} and ${formatUsd(data.vaultUsdc)}`, "USDC arrives as buyers take the tokens; not redemption backing"],
                [
                  `Share of the pool's ${symbol}`,
                  data.tokenShareBps === null ? "n/a (the pool holds none)" : formatBps(data.tokenShareBps),
                  "the rest, if any, was added by others and is not locked",
                ],
                ["Position owner", allVaultOwned ? "the vault (Launch PDA)" : "not all owned by the vault", "decoded from each position"],
                [
                  "Lock release",
                  allNever ? "never, for every position" : "at least one position has a release point",
                  "the slot from which liquidity may be withdrawn; decoded from each position",
                ],
                ["Fee owner", data.feesToVault ? "the vault" : "not the vault for every position", "the only account DLMM pays these positions' swap fees to"],
                [
                  "Operator",
                  operators.length === 1 ? <Address key="operator" value={operators[0]} /> : `${operators.length} wallets`,
                  "the only wallet that can trigger a fee claim; it cannot withdraw the liquidity",
                ],
              ] as [string, React.ReactNode, string?][])
            : []),
          [
            "Unclaimed pool fees",
            formatUsd(data.unclaimedUsdc, 6) + (data.unclaimedTokens > 0n ? ` and ${tokens(data.unclaimedTokens)}` : ""),
            "swap fees earned by the vault's positions; they join vault equity once claimed",
          ],
        ]}
      />
      {canClaim && data.positions.length > 0 && (
        <p>
          <button disabled={!hasFees} onClick={claim}>
            Claim pool fees into the vault
          </button>{" "}
          {!hasFees && <span className="muted small">Nothing to claim yet.</span>}
        </p>
      )}
      <p className="muted small">
        A launch made on this site puts its pool allocation into the pool as tokens only, in positions owned by the
        vault with a lock that never releases. Nobody can withdraw that liquidity: the creator&apos;s wallet is only
        the positions&apos; operator, which Meteora does not let remove locked liquidity, and the vault program has no
        instruction that withdraws it. The lock is created by the create flow and shown here from chain. The Terp
        program does not enforce it, so a launch made with other tooling can be unlocked, and this section says so
        when it is. Anyone can add their own, unlocked, liquidity next to the vault&apos;s.
      </p>
      <p className="muted small">
        Swap fees of the pool accrue to those positions in USDC. Only the operator can trigger a claim and Meteora
        sends it to the vault&apos;s USDC account, nowhere else; unclaimed fees stay in the positions and are not
        lost. Meteora&apos;s fee is not flat: it rises with the number of price bins a swap crosses, so a large buy
        into a thin, early pool pays far more than the base fee (in a local test, one buy that crossed about 65 bins
        paid about 8%).
      </p>
    </Panel>
  );
}
