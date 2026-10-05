/**
 * Lists a Phoenix perp market as a leveraged asset that new launches can choose.
 *
 *   RPC_URL=... ADMIN_KEYPAIR=<path> pnpm --filter @terp/scripts add-market --symbol SOL [--dry-run]
 *
 * The market's parameters are read from Phoenix's public API and checked against the chain
 * before anything is signed. A listing is permanent and cannot be edited; it affects only
 * launches created with it afterwards.
 */
import { PHOENIX_API_URL, PHOENIX_PROGRAM_ID, TerpClient, marketPda } from "@terp/sdk";
import { PublicKey } from "@solana/web3.js";
import { connect, env, loadKeypair, reviewAndSend, stringArg } from "./lib";

async function main() {
  const connection = connect();
  const admin = loadKeypair(env("ADMIN_KEYPAIR"));
  const symbol = stringArg("symbol").toUpperCase();
  const client = new TerpClient(connection);

  const markets = (await (await fetch(`${PHOENIX_API_URL}/exchange/markets`)).json()) as any[];
  const found = markets.find((m) => m.symbol === symbol);
  if (!found) throw new Error(`Phoenix lists no market with symbol ${symbol}`);
  if (found.marketStatus !== "active") throw new Error(`${symbol} is not active on Phoenix (${found.marketStatus})`);

  const orderbook = new PublicKey(found.marketPubkey);
  const spline = new PublicKey(found.splinePubkey);
  const [derived] = PublicKey.findProgramAddressSync([Buffer.from("spline"), orderbook.toBuffer()], PHOENIX_PROGRAM_ID);
  if (!derived.equals(spline)) throw new Error("spline address from the API is not the orderbook's spline PDA");
  const [orderbookInfo, splineInfo] = await connection.getMultipleAccountsInfo([orderbook, spline]);
  if (!orderbookInfo?.owner.equals(PHOENIX_PROGRAM_ID) || !splineInfo?.owner.equals(PHOENIX_PROGRAM_ID)) {
    throw new Error("orderbook or spline is not a Phoenix account on this cluster");
  }

  const existing = (await client.fetchMarkets()).find((m) => m.assetId === found.assetId);
  if (existing) {
    console.log(`${existing.symbol} (asset ${existing.assetId}) is already listed at ${existing.address.toBase58()}`);
    return;
  }

  await reviewAndSend(connection, {
    title: `List ${symbol} as a leveraged asset`,
    payer: admin,
    effects: [
      `market account ${marketPda(found.assetId).toBase58()} for Phoenix asset ${found.assetId} (${symbol})`,
      `orderbook ${orderbook.toBase58()}, tick size ${found.tickSize}, base lot 10^-${found.baseLotsDecimals} ${symbol}`,
      `Phoenix allows up to ${found.leverageTiers?.[0]?.maxLeverage}x on this market; launches open at 5x`,
      found.isolatedOnly ? "WARNING: Phoenix marks this market isolated-only; vaults use a cross-margin account" : "cross-margin market",
      "permanent: a listing cannot be changed or removed",
      "cost: rent for one small account, paid by the admin",
    ],
    instructions: [
      await client.addMarketIx(admin.publicKey, {
        assetId: found.assetId,
        symbol,
        orderbook,
        spline,
        tickSize: BigInt(found.tickSize),
        baseLotDecimals: found.baseLotsDecimals,
      }),
    ],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
