/**
 * The Terp keeper: the launchpad operator's service.
 *
 * Its key is the one named in the protocol config, and it is the only key that may convert tax
 * and deploy it. It decides *when*. The program decides everything else: the batch size, the
 * price floor, the order size and limit, whether exposure is added (only under the minimum
 * leverage, only up to target), and where proceeds go: the launch's fixed keeper fee to the
 * platform treasury, the rest to the launch's own vault. The keeper cannot withdraw from a vault
 * or send funds anywhere.
 *
 * Per launch and cycle:
 *
 *   1. unwrap canonical tokens that arrived from a queued Phoenix withdrawal
 *   2. pay redeemers' claims from idle USDC; re-request a withdrawal Phoenix dropped
 *   3. deleverage a vault above its maximum leverage
 *   4. collect withheld tax, sell a batch, deploy the proceeds: ONE transaction when possible
 *
 * Steps 1 to 3 are open to any wallet on-chain; the keeper just does them promptly. If the
 * keeper is offline, tax waits in the vault and redemptions are unaffected.
 *
 * KEEPER_MODE=dry-run (default) simulates everything and sends nothing.
 */
import { TerpClient, launchAddresses, math, usdcAta, type Launch, type VaultState } from "@terp/sdk";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { loadConfig, type KeeperConfig } from "./config";
import { buildTaxSwap } from "./dlmm";
import { Sender, log } from "./tx";

const usd = (atoms: bigint) => `$${(Number(atoms) / 1e6).toFixed(2)}`;
const x = (bps: bigint | number | null) => (bps === null ? "n/a" : `${(Number(bps) / 10_000).toFixed(2)}x`);

class Keeper {
  private cycle = 0;
  /** The platform treasury from the config: where the program sends the keeper fee. */
  private treasury = PublicKey.default;

  constructor(
    private readonly connection: Connection,
    private readonly client: TerpClient,
    private readonly sender: Sender,
    private readonly config: KeeperConfig,
  ) {}

  private get key() {
    return this.config.keypair.publicKey;
  }

  async run() {
    const config = await this.client.fetchConfig();
    if (!config) throw new Error("protocol config not found: program not deployed or not initialised");
    if (!config.keeper.equals(this.key)) {
      throw new Error(`this key (${this.key.toBase58()}) is not the configured keeper (${config.keeper.toBase58()})`);
    }
    this.treasury = config.treasury;
    if (!(await this.connection.getAccountInfo(usdcAta(config.treasury)))) {
      throw new Error(
        `the treasury (${config.treasury.toBase58()}) has no USDC account; conversions pay the keeper fee there. ` +
          "Create its associated USDC account first (init-config does this).",
      );
    }
    log(
      "keeper",
      `mode=${this.config.mode} keeper=${this.key.toBase58()} treasury=${config.treasury.toBase58()} paused=${config.paused}`,
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
        log("keeper", `cycle failed: ${String(error).slice(0, 300)}`);
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

    // 3. risk
    if (work.canDeleverage && !state.markIsStale) {
      await this.sender.send(scope, id, `deleverage from ${x(state.leverageBps)} back to target`, [
        await this.client.deleverageIx(this.key, launch),
      ]);
      return;
    }
    if (paused) return;

    // 4. tax -> USDC -> collateral, in one transaction when possible
    await this.putTaxToWork(scope, id, state);
  }

  private async putTaxToWork(scope: string, id: string, state: VaultState) {
    const { launch } = state;
    const steps: { name: string; ixs: TransactionInstruction[] }[] = [];

    // collect: the scan for withheld accounts is heavy, so not every cycle
    let taxTokens = state.taxTokens;
    if (this.cycle % this.config.collectEveryCycles === 1) {
      const withheld = await this.client.findWithheld(launch.mint);
      const collectable = withheld.reduce((sum, w) => sum + w.amount, state.withheldOnMint);
      if (collectable > 0n) {
        taxTokens += collectable;
        steps.push({
          name: `collect ${collectable} tax tokens from ${withheld.length} account(s)`,
          ixs: [await this.client.collectTaxIx(this.key, launch, withheld.map((w) => w.account))],
        });
      }
    }

    // convert: the program fixes the batch (the balance, capped) and enforces the price floor
    let incoming = 0n;
    const cooled =
      launch.tokensConverted === 0n || state.slot - launch.lastConvertSlot >= launch.convertCooldownSlots;
    if (launch.pool && cooled && taxTokens >= launch.minConvertTokens) {
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
        // the vault receives the proceeds less the launch's keeper fee, which goes to the treasury
        const fee = (swap.expectedOut * BigInt(launch.keeperFeeBps)) / 10_000n;
        incoming = swap.minOut - (swap.minOut * BigInt(launch.keeperFeeBps)) / 10_000n;
        steps.push({
          name: `convert ${batch} tax tokens (pool quote ${usd(swap.expectedOut)}, keeper fee ${usd(fee)})`,
          ixs: [await this.client.convertTaxIx(this.key, launch, batch, swap.instruction, this.treasury)],
        });
      }
    }

    // deploy: deposit as margin; the program also tops exposure up to target when leverage is
    // then under the launch minimum
    const onboarded = Boolean(state.trader?.isOnboarded);
    const deposit = state.freeUsdc + incoming >= launch.minDepositUsdc ? state.freeUsdc + incoming : 0n;
    const work = this.client.pendingWork({ ...state, freeUsdc: state.freeUsdc + incoming }, false);
    if (onboarded && !state.markIsStale && work.canDeploy) {
      const what = work.wouldIncrease
        ? `deposit ${usd(deposit)} and top the position up to ${x(launch.targetLeverageBps)}`
        : `deposit ${usd(deposit)} as margin only (leverage ${x(state.leverageBps)})`;
      steps.push({ name: what, ixs: [await this.client.deployIx(this.key, launch)] });
    } else if (deposit > 0n && !onboarded) {
      log(scope, "USDC is waiting for Phoenix onboarding of the launch trader");
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
      for (const step of steps) {
        if ((await this.sender.send(scope, id, step.name, step.ixs)) === "failed") break;
      }
    }
  }
}

async function main() {
  const config = loadConfig();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const client = new TerpClient(connection);
  await new Keeper(connection, client, new Sender(connection, config), config).run();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
