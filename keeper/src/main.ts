/**
 * The Terp crank: a small open bot that sends the vaults' upkeep transactions.
 *
 * It has no role on-chain. Every instruction it sends is open to any wallet, and its key is
 * only a fee-paying wallet: it needs a little SOL, holds no funds and receives nothing. It
 * decides *when*. The program decides everything else: the batch size, the price floor, the
 * order size and limit, whether exposure is added or cut, and where proceeds go: the launch's
 * fixed platform fee to the platform treasury, the rest to the launch's own vault.
 *
 * Trades made through Terp's site already carry these steps, so an actively traded token needs
 * no bot. The crank covers tokens nobody is trading there. Anyone can run it.
 *
 * Per launch and cycle:
 *
 *   1. unwrap canonical tokens that arrived from a queued Phoenix withdrawal
 *   2. pay redeemers' claims from idle USDC; re-request a withdrawal Phoenix dropped
 *   3. collect withheld tax, sell a batch, rebalance the position: ONE transaction when possible
 *
 * If no crank runs and nobody trades on Terp's site, tax waits and the position is not
 * adjusted; redemptions are unaffected.
 *
 * KEEPER_MODE=dry-run (default) simulates everything and sends nothing.
 */
import { TerpClient, launchAddresses, math, usdcAta, type Launch, type VaultState } from "@terp/sdk";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { loadConfig, type CrankConfig } from "./config";
import { buildTaxSwap } from "./dlmm";
import { Sender, log } from "./tx";

const usd = (atoms: bigint) => `$${(Number(atoms) / 1e6).toFixed(2)}`;
const x = (bps: bigint | number | null) => (bps === null ? "n/a" : `${(Number(bps) / 10_000).toFixed(2)}x`);

interface Step {
  name: string;
  ixs: TransactionInstruction[];
  /** Whether the step is worth a transaction of its own when the combined one fails. */
  alone: boolean;
}

class Crank {
  private cycle = 0;
  /** The platform treasury from the config: where the program sends the platform fee. */
  private treasury = PublicKey.default;

  constructor(
    private readonly connection: Connection,
    private readonly client: TerpClient,
    private readonly sender: Sender,
    private readonly config: CrankConfig,
  ) {}

  private get key() {
    return this.config.keypair.publicKey;
  }

  async run() {
    const config = await this.client.fetchConfig();
    if (!config) throw new Error("protocol config not found: program not deployed or not initialised");
    this.treasury = config.treasury;
    if (!(await this.connection.getAccountInfo(usdcAta(config.treasury)))) {
      throw new Error(
        `the treasury (${config.treasury.toBase58()}) has no USDC account; conversions pay the platform fee there. ` +
          "Create its associated USDC account first (init-config does this).",
      );
    }
    log(
      "crank",
      `mode=${this.config.mode} wallet=${this.key.toBase58()} treasury=${config.treasury.toBase58()} paused=${config.paused}`,
    );

    for (;;) {
      this.cycle += 1;
      try {
        const current = await this.client.fetchConfig();
        const paused = current?.paused ?? true;
        if (current) this.treasury = current.treasury;
        for (const launch of await this.client.fetchAllLaunches()) {
          try {
            await this.tick(launch, paused);
          } catch (error) {
            log(launch.mint.toBase58().slice(0, 8), `error: ${String(error).slice(0, 300)}`);
          }
        }
      } catch (error) {
        log("crank", `cycle failed: ${String(error).slice(0, 300)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.intervalMs));
    }
  }

  private async tick(launch: Launch, paused: boolean) {
    const scope = launch.mint.toBase58().slice(0, 8);
    const id = launch.address.toBase58();
    const state = await this.client.fetchVaultState(launch, this.key);
    const work = this.client.pendingWork(state, paused);
    log(
      scope,
      `E=${usd(state.equity)} idle=${usd(state.idleUsdc)} claims=${usd(launch.pendingClaims)} ` +
        `${launch.symbol} notional=${usd(state.perp.notional)} lev=${x(state.leverageBps)} risk=${state.risk} tax=${state.taxTokens}`,
    );

    // 1. a queued Phoenix withdrawal has been paid in canonical tokens
    if (work.canonicalToUnwrap > 0n) {
      await this.sender.send(scope, id, `unwrap ${usd(work.canonicalToUnwrap)} of canonical collateral`, [
        await this.client.unwrapCanonicalIx(this.key, launch),
      ]);
      return;
    }

    // 2. claims: pay what the vault can, re-request what Phoenix dropped
    if (launch.pendingClaims > 0n) {
      if (state.idleUsdc > 0n) {
        for (const claim of await this.client.fetchClaims(launch.address)) {
          await this.sender.send(
            scope,
            id,
            `pay claim of ${claim.owner.toBase58()} (${usd(claim.amount)})`,
            await this.client.payClaimIxs(this.key, launch, claim.owner),
          );
        }
        return;
      }
      if (work.claimsShortfall > 0n && !state.markIsStale) {
        await this.sender.send(scope, id, `re-request ${usd(work.claimsShortfall)} from Phoenix for claims`, [
          await this.client.fundClaimsIx(this.key, launch),
        ]);
        return;
      }
    }

    // 3. tax -> USDC -> position, in one transaction when possible
    await this.upkeep(scope, id, state, paused);
  }

  private async upkeep(scope: string, id: string, state: VaultState, paused: boolean) {
    const { launch } = state;
    const steps: Step[] = [];

    // collect: the scan for withheld accounts is heavy, so not every cycle
    let taxTokens = state.taxTokens;
    if (!paused && this.cycle % this.config.collectEveryCycles === 1) {
      const withheld = await this.client.findWithheld(launch.mint);
      const collectable = withheld.reduce((sum, w) => sum + w.amount, state.withheldOnMint);
      if (collectable > 0n) {
        taxTokens += collectable;
        steps.push({
          name: `collect ${collectable} tax tokens from ${withheld.length} account(s)`,
          ixs: [await this.client.collectTaxIx(this.key, launch, withheld.map((w) => w.account))],
          alone: true,
        });
      }
    }

    // convert: the program fixes the batch (the balance, capped) and enforces the price floor
    let incoming = 0n;
    const cooled =
      launch.tokensConverted === 0n || state.slot - launch.lastConvertSlot >= launch.convertCooldownSlots;
    if (!paused && launch.pool && cooled && taxTokens >= launch.minConvertTokens) {
      const batch = taxTokens < launch.maxConvertTokens ? taxTokens : launch.maxConvertTokens;
      const taxAuthority = launchAddresses(launch.mint, this.client.programId).taxAuthority;
      const swap = await buildTaxSwap(this.connection, launch, taxAuthority, batch, this.config.swapSlippageBps);
      const floor = math.conversionPriceFloor(
        launch.emaPrice,
        launch.maxPriceDropBps,
        state.slot - launch.lastConvertSlot,
        launch.convertCooldownSlots,
      );
      if (swap.minOut === 0n || math.conversionPrice(swap.minOut, batch) < floor) {
        log(scope, "pool price is below the conversion floor; not converting yet");
      } else {
        // the vault receives the proceeds less the launch's platform fee, which goes to the treasury
        const fee = (swap.expectedOut * BigInt(launch.platformFeeBps)) / 10_000n;
        incoming = swap.minOut - (swap.minOut * BigInt(launch.platformFeeBps)) / 10_000n;
        steps.push({
          name: `convert ${batch} tax tokens (pool quote ${usd(swap.expectedOut)}, platform fee ${usd(fee)})`,
          ixs: [await this.client.convertTaxIx(this.key, launch, batch, swap.instruction, this.treasury)],
          alone: true,
        });
      }
    }

    // rebalance: the program cuts the position above the maximum leverage; otherwise it deposits
    // idle USDC and tops exposure up to target under the minimum. With nothing to do it succeeds
    // doing nothing, so it rides along with the steps above whenever the launch has a trader. On
    // its own it is only sent when the vault's state says it would act: an empty call still
    // costs the network fee.
    if (launch.traderAccount) {
      const onboarded = Boolean(state.trader?.isOnboarded);
      const free = state.freeUsdc + incoming;
      const work = this.client.pendingWork({ ...state, freeUsdc: free }, paused);
      // a stale mark stops orders, not deposits
      const useful = work.canDeleverage
        ? !state.markIsStale
        : work.canDeploy && (work.deployUsdc > 0n || !state.markIsStale);
      let what = "rebalance (nothing expected to change)";
      if (work.canDeleverage) {
        what = `rebalance: cut the position from ${x(state.leverageBps)} to ${x(launch.deleverageToBps)}`;
      } else if (work.wouldIncrease) {
        what = `rebalance: deposit ${usd(work.deployUsdc)} and top the position up to ${x(launch.targetLeverageBps)}`;
      } else if (work.deployUsdc > 0n) {
        what = `rebalance: deposit ${usd(work.deployUsdc)} as margin only (leverage ${x(state.leverageBps)})`;
      }
      if (useful || steps.length > 0) {
        steps.push({ name: what, ixs: [await this.client.rebalanceIx(this.key, launch)], alone: useful });
      }
      if (!onboarded && free >= launch.minDepositUsdc) {
        log(scope, "USDC is waiting for Phoenix onboarding of the launch trader");
      }
    }

    if (steps.length === 0) return;
    const outcome = await this.sender.send(
      scope,
      id,
      steps.map((s) => s.name).join(" + "),
      steps.flatMap((s) => s.ixs),
    );
    // if the combined transaction cannot go through, do the steps one at a time
    if (outcome === "failed" && steps.length > 1) {
      for (const step of steps.filter((s) => s.alone)) {
        if ((await this.sender.send(scope, id, step.name, step.ixs)) === "failed") break;
      }
    }
  }
}

async function main() {
  const config = loadConfig();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const client = new TerpClient(connection);
  await new Crank(connection, client, new Sender(connection, config), config).run();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
