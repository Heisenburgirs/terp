/**
 * Read-only mainnet preflight. Sends nothing and needs no keypair.
 *
 *   RPC_URL=https://... pnpm --filter @terp/scripts preflight
 *
 * Checks that every external program and account the system depends on exists and has the shape
 * the code expects, exercises the Hawkeye view path against a live trader account, and reports
 * whether the launchpad program itself is deployed and configured.
 */
import {
  DLMM_PROGRAM_ID,
  EMBER_PROGRAM_ID,
  EMBER_STATE,
  EMBER_VAULT,
  HAWKEYE_PROGRAM_ID,
  PHOENIX_API_URL,
  PHOENIX_GLOBAL_CONFIG,
  PHOENIX_LOG_AUTHORITY,
  PHOENIX_PROGRAM_ID,
  SOL_MARKET,
  TERP_PROGRAM_ID,
  TerpClient,
  USDC_MINT,
  fetchExchange,
  fetchMark,
  fetchPerpView,
  lastViewUnits,
  ticksToUsd,
} from "@terp/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { connect, isMainnet, usdc } from "./lib";

let failures = 0;
const pass = (label: string, detail = "") => console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
const fail = (label: string, detail = "") => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (label: string, detail = "") => console.log(`  note  ${label}${detail ? `  ${detail}` : ""}`);

/** A trader account that recently traded the SOL market, to exercise the margin views on. */
async function findLiveTrader(connection: Connection): Promise<PublicKey | null> {
  const traderDiscriminator = Buffer.from([41, 97, 73, 105, 110, 214, 112, 9]);
  const signatures = await connection.getSignaturesForAddress(SOL_MARKET.orderbook, { limit: 5 });
  for (const { signature } of signatures) {
    const transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!transaction) continue;
    const keys = transaction.transaction.message.getAccountKeys({
      accountKeysFromLookups: transaction.meta?.loadedAddresses,
    });
    const candidates = keys.keySegments().flat().slice(0, 40);
    const infos = await connection.getMultipleAccountsInfo(candidates, { dataSlice: { offset: 0, length: 8 } });
    const at = infos.findIndex(
      (info) => info?.owner.equals(PHOENIX_PROGRAM_ID) && Buffer.from(info.data).equals(traderDiscriminator),
    );
    if (at >= 0) return candidates[at];
  }
  return null;
}

async function main() {
  const connection = connect();
  console.log(`cluster: ${(await isMainnet(connection)) ? "mainnet-beta" : "NOT mainnet"}\n`);

  console.log("External programs");
  const programs: [string, PublicKey][] = [
    ["Phoenix perps (Eternal)", PHOENIX_PROGRAM_ID],
    ["Ember (USDC wrapper)", EMBER_PROGRAM_ID],
    ["Hawkeye (margin views)", HAWKEYE_PROGRAM_ID],
    ["Meteora DLMM", DLMM_PROGRAM_ID],
  ];
  const infos = await connection.getMultipleAccountsInfo(programs.map(([, key]) => key));
  programs.forEach(([name, key], i) =>
    infos[i]?.executable ? pass(name, key.toBase58()) : fail(name, `${key.toBase58()} is not an executable account`),
  );

  console.log("\nPhoenix exchange accounts");
  const pdaOf = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
  pdaOf([Buffer.from("global")], PHOENIX_PROGRAM_ID).equals(PHOENIX_GLOBAL_CONFIG)
    ? pass("global configuration PDA")
    : fail("global configuration PDA");
  pdaOf([Buffer.from("log")], PHOENIX_PROGRAM_ID).equals(PHOENIX_LOG_AUTHORITY)
    ? pass("log authority PDA")
    : fail("log authority PDA");
  pdaOf([PHOENIX_PROGRAM_ID.toBuffer(), Buffer.from("state")], EMBER_PROGRAM_ID).equals(EMBER_STATE)
    ? pass("Ember state PDA")
    : fail("Ember state PDA");
  pdaOf([PHOENIX_PROGRAM_ID.toBuffer(), Buffer.from("vault")], EMBER_PROGRAM_ID).equals(EMBER_VAULT)
    ? pass("Ember vault PDA")
    : fail("Ember vault PDA");

  const exchange = await fetchExchange(connection);
  pass("global configuration parsed", `canonical mint ${exchange.canonicalMint.toBase58()}`);
  note("trader-index tail", `${exchange.tail.length} account(s)`);
  note("deposit cooldown", `${exchange.depositCooldownSlots} slot(s) before a deposit can be withdrawn`);

  // cross-check the on-chain parse against Phoenix's public API
  let simulationPayer = "8wTcJdg4Xw3wnvmBu7Sokn3c2UnnHUhuB5g9sfeCMidR";
  try {
    const keys = (await (await fetch(`${PHOENIX_API_URL}/v1/view/exchange/keys`)).json()) as Record<string, any>;
    simulationPayer = keys.currentAuthorities?.riskAuthority ?? simulationPayer;
    const same =
      keys.canonicalMint === exchange.canonicalMint.toBase58() &&
      keys.globalVault === exchange.globalVault.toBase58() &&
      keys.perpAssetMap === exchange.perpAssetMap.toBase58() &&
      keys.withdrawQueue === exchange.withdrawQueue.toBase58() &&
      [...keys.globalTraderIndex, ...keys.activeTraderBuffer].join() === exchange.tail.map((k) => k.toBase58()).join();
    same ? pass("matches Phoenix API /v1/view/exchange/keys") : fail("differs from Phoenix API /v1/view/exchange/keys");

    const markets = (await (await fetch(`${PHOENIX_API_URL}/exchange/markets`)).json()) as any[];
    const market = markets.find((m) => m.symbol === SOL_MARKET.symbol);
    market &&
    market.assetId === SOL_MARKET.assetId &&
    market.marketPubkey === SOL_MARKET.orderbook.toBase58() &&
    market.splinePubkey === SOL_MARKET.spline.toBase58() &&
    market.tickSize === SOL_MARKET.tickSize &&
    market.baseLotsDecimals === SOL_MARKET.baseLotDecimals
      ? pass("SOL market constants match the API", `taker fee ${market.takerFee * 1e4} bps, max leverage ${market.leverageTiers[0].maxLeverage}x`)
      : fail("SOL market constants differ from the API");
  } catch (error) {
    note("Phoenix API unreachable; skipped the cross-check", String(error));
  }

  console.log("\nHawkeye views (simulated, read-only)");
  // The fee payer of a simulation only has to be a funded system account; nothing is signed or
  // sent. Defaults to Phoenix's risk authority, which pays for exchange cranks.
  const payerAt = process.argv.indexOf("--payer");
  const payer = new PublicKey(payerAt > 0 ? process.argv[payerAt + 1] : simulationPayer);
  try {
    const mark = await fetchMark(connection, exchange, SOL_MARKET, payer);
    const slot = await connection.getSlot();
    pass(
      "view_bbo",
      `SOL mark $${ticksToUsd(mark.markPriceTicks, SOL_MARKET).toFixed(2)}, updated ${BigInt(slot) - mark.markPriceSlot} slot(s) ago`,
    );
  } catch (error) {
    fail("view_bbo", String(error).slice(0, 300));
  }
  note("view_bbo cost", `${lastViewUnits} compute units`);
  try {
    const traderAt = process.argv.indexOf("--trader");
    const trader = traderAt > 0 ? new PublicKey(process.argv[traderAt + 1]) : await findLiveTrader(connection);
    if (!trader) {
      note("no live trader found in recent SOL market transactions; pass --trader <trader account>");
    } else {
      const view = await fetchPerpView(connection, exchange, SOL_MARKET, trader, payer);
      pass("view_margin / view_margin_for_asset", `trader ${trader.toBase58()}`);
      note("equity", usdc(view.equity < 0n ? 0n : view.equity));
      note("SOL position", `${view.baseLots} base lot(s), notional ${usdc(view.notional)}`);
      note("last view cost", `${lastViewUnits} compute units`);
    }
  } catch (error) {
    fail("view_margin", String(error).slice(0, 300));
  }

  console.log("\nLaunchpad program");
  const program = await connection.getAccountInfo(TERP_PROGRAM_ID);
  if (!program?.executable) {
    note("not deployed on this cluster", TERP_PROGRAM_ID.toBase58());
    note("see docs/DEPLOYMENT.md; deploying spends SOL and needs your explicit go-ahead");
  } else {
    pass("deployed", TERP_PROGRAM_ID.toBase58());
    const client = new TerpClient(connection);
    const config = await client.fetchConfig();
    if (!config) note("config not initialised yet (scripts/init-config.ts)");
    else {
      pass(
        "config",
        `admin ${config.admin.toBase58()}, treasury ${config.treasury.toBase58()}, platform fee ${config.platformFeeBps / 100}%`,
      );
      config.swapProgram.equals(DLMM_PROGRAM_ID) ? pass("swap program is Meteora DLMM") : fail("swap program is not Meteora DLMM");
      note("paused", String(config.paused));

      // every listed leveraged asset must still match what Phoenix publishes for it
      const listed = await client.fetchMarkets();
      if (listed.length === 0) note("no leveraged assets listed yet (scripts/add-market.ts)");
      const published = (await (await fetch(`${PHOENIX_API_URL}/exchange/markets`)).json()) as any[];
      for (const market of listed) {
        const source = published.find((m) => m.assetId === market.assetId);
        source &&
        source.symbol === market.symbol &&
        source.marketPubkey === market.orderbook.toBase58() &&
        source.splinePubkey === market.spline.toBase58() &&
        BigInt(source.tickSize) === market.tickSize &&
        source.baseLotsDecimals === market.baseLotDecimals
          ? pass(`listed market ${market.symbol}`, `asset ${market.assetId}`)
          : fail(`listed market ${market.symbol} does not match Phoenix's API`);
      }
    }
  }
  const usdcMint = await connection.getAccountInfo(USDC_MINT);
  usdcMint ? pass("USDC mint") : fail("USDC mint missing");

  console.log(failures === 0 ? "\npreflight passed" : `\npreflight found ${failures} problem(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
