/**
 * Initialises the protocol config, once, right after the program is deployed.
 *
 *   RPC_URL=... ADMIN_KEYPAIR=~/.config/solana/id.json \
 *   pnpm --filter @terp/scripts init-config --treasury <pubkey> \
 *     [--platform-fee-bps <0..2000, default 300 = 3%>] [--dry-run]
 *
 * The platform fee is the platform's revenue: that share of the USDC from every tax sale is
 * paid to the treasury's USDC account, which this script creates if it is missing. A launch
 * keeps the rate that was in force when it was created. Selling tax and adjusting positions
 * need no special key: those instructions are open to any wallet.
 *
 * `init_config` can be called by whoever gets there first, so run it immediately after
 * deploying and check the printed admin afterwards. If someone else initialised it, do not use that deployment: redeploy under
 * a new program id. Then list at least one leveraged asset with `add-market`.
 */
import { DLMM_PROGRAM_ID, MAX_PLATFORM_FEE_BPS, TerpClient, configPda, createUsdcAccountIx } from "@terp/sdk";
import { createHash } from "node:crypto";
import { connect, env, loadKeypair, pubkeyArg, reviewAndSend, stringArg } from "./lib";

const sighash = (name: string) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];

async function main() {
  const connection = connect();
  const admin = loadKeypair(env("ADMIN_KEYPAIR"));
  const treasury = pubkeyArg("treasury");
  const platformFeeBps = Number(stringArg("platform-fee-bps", "300"));
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > MAX_PLATFORM_FEE_BPS) {
    throw new Error(`--platform-fee-bps must be a whole number from 0 to ${MAX_PLATFORM_FEE_BPS}`);
  }
  const client = new TerpClient(connection);

  const existing = await client.fetchConfig();
  if (existing) {
    console.log(`config already exists at ${configPda().toBase58()}`);
    console.log(`  admin    ${existing.admin.toBase58()}${existing.admin.equals(admin.publicKey) ? "" : "   <-- NOT your key"}`);
    console.log(`  treasury ${existing.treasury.toBase58()}`);
    console.log(`  platform fee ${existing.platformFeeBps / 100}% of converted tax, for new launches`);
    return;
  }

  // exact-input swaps only: the program fixes how many tokens a conversion sells
  const swapDiscriminators = [sighash("swap"), sighash("swap2")];
  await reviewAndSend(connection, {
    title: "Initialise protocol config",
    payer: admin,
    effects: [
      `admin = ${admin.publicKey.toBase58()} (can rotate admin/treasury, list leveraged assets, pause risk-increasing actions; cannot move funds)`,
      `treasury = ${treasury.toBase58()} (receives the platform fee, and residual USDC of launches whose supply reached zero)`,
      `platform fee = ${platformFeeBps / 100}% of every tax conversion, paid to the treasury; each launch keeps the rate it was created with`,
      "creates the treasury's associated USDC account if it does not exist",
      "no operator key: sweeping tax, selling it, rebalancing, redemption and claim payouts are callable by anyone; sizes, prices and destinations are fixed by the program",
      `swap program = Meteora DLMM ${DLMM_PROGRAM_ID.toBase58()}, instructions swap and swap2 (immutable)`,
      "cost: rent for one small account (two if the treasury's USDC account is new), paid by the admin",
    ],
    instructions: [
      createUsdcAccountIx(admin.publicKey, treasury),
      await client.initConfigIx(admin.publicKey, {
        treasury,
        platformFeeBps,
        swapProgram: DLMM_PROGRAM_ID,
        swapDiscriminators,
      }),
    ],
  });

  const config = await client.fetchConfig();
  if (config) console.log(`config admin is now ${config.admin.toBase58()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
