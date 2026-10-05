/**
 * Pauses or unpauses risk-increasing actions: new launches, tax conversion, deposits and buys.
 * Reductions, withdrawals to the vault and redemptions are never paused.
 *
 *   RPC_URL=... ADMIN_KEYPAIR=<path> pnpm --filter @terp/scripts set-paused --paused true
 */
import { TerpClient } from "@terp/sdk";
import { connect, env, loadKeypair, reviewAndSend, stringArg } from "./lib";

async function main() {
  const connection = connect();
  const admin = loadKeypair(env("ADMIN_KEYPAIR"));
  const paused = stringArg("paused") === "true";
  const client = new TerpClient(connection);
  const config = await client.fetchConfig();
  if (!config) throw new Error("protocol config not found");
  if (config.paused === paused) {
    console.log(`already ${paused ? "paused" : "unpaused"}`);
    return;
  }
  await reviewAndSend(connection, {
    title: paused ? "Pause risk-increasing actions" : "Unpause",
    payer: admin,
    effects: [
      paused
        ? "blocks new launches, tax conversion, collateral deposits and position increases"
        : "allows new launches, tax conversion, collateral deposits and position increases again",
      "does not affect reductions, withdrawals to the vault, or redemptions",
    ],
    instructions: [await client.updateConfigIx(admin.publicKey, { paused })],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
