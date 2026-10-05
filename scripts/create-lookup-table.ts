/**
 * Creates the protocol's shared address lookup table.
 *
 *   RPC_URL=... PAYER_KEYPAIR=<path> pnpm --filter @terp/scripts create-lookup-table [--dry-run]
 *
 * Redemptions, deployments and deleveraging touch about three dozen accounts, most of them the
 * same Phoenix accounts every time. Putting those in a lookup table lets each of these fit in
 * one transaction. The table holds addresses only; it grants nothing. Set its address as
 * LOOKUP_TABLE for the bot and NEXT_PUBLIC_LOOKUP_TABLE for the frontend.
 *
 * Run it after `init-config`. It costs a little rent, paid by the payer, who becomes the
 * table's authority (it can add addresses, never remove them).
 */
import { TerpClient } from "@terp/sdk";
import { AddressLookupTableProgram } from "@solana/web3.js";
import { connect, env, loadKeypair, reviewAndSend } from "./lib";

async function main() {
  const connection = connect();
  const payer = loadKeypair(env("PAYER_KEYPAIR"));
  const client = new TerpClient(connection);
  if (!(await client.fetchConfig())) throw new Error("protocol config not found; run init-config first");

  const addresses = await client.lookupTableAddresses();
  const slot = await connection.getSlot("finalized");
  const [create, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  const extend = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: table,
    addresses,
  });

  const sent = await reviewAndSend(connection, {
    title: "Create the shared address lookup table",
    payer,
    effects: [
      `creates lookup table ${table.toBase58()} with ${addresses.length} addresses (programs and Phoenix exchange accounts)`,
      "addresses only: the table confers no authority over anything",
      "cost: rent for the table, paid by the payer",
    ],
    instructions: [create, extend],
  });
  if (sent) {
    console.log(`\nLOOKUP_TABLE=${table.toBase58()}`);
    console.log(`NEXT_PUBLIC_LOOKUP_TABLE=${table.toBase58()}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
