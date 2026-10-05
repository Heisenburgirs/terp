/**
 * Initialises the protocol config, once, right after the program is deployed.
 *
 *   RPC_URL=... ADMIN_KEYPAIR=~/.config/solana/id.json \
 *   pnpm --filter @terp/scripts init-config --keeper <pubkey> --treasury <pubkey> \
 *     [--keeper-fee-bps <0..2000, default 300 = 3%>] [--dry-run]
 *
 * The keeper is the operator key that may convert tax and deploy it; it cannot withdraw from
 * any vault. The keeper fee is the platform's revenue: that share of every tax conversion is paid
 * to the treasury's USDC account, which this script creates if it is missing. A launch keeps the
 * rate that was in force when it was created. `init_config` can be called by whoever gets there first, so run it immediately after deploying and check the printed
 * admin afterwards. If someone else initialised it, do not use that deployment: redeploy under
 * a new program id. Then list at least one leveraged asset with `add-market`.
 */
import { DLMM_PROGRAM_ID, MAX_KEEPER_FEE_BPS, TerpClient, configPda, createUsdcAccountIx } from "@terp/sdk";
import { createHash } from "node:crypto";
import { connect, env, loadKeypair, pubkeyArg, reviewAndSend, stringArg } from "./lib";

const sighash = (name: string) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];

async function main() {
  const connection = connect();
  const admin = loadKeypair(env("ADMIN_KEYPAIR"));
  const keeper = pubkeyArg("keeper");
  const treasury = pubkeyArg("treasury");
  const keeperFeeBps = Number(stringArg("keeper-fee-bps", "300"));
  if (!Number.isInteger(keeperFeeBps) || keeperFeeBps < 0 || keeperFeeBps > MAX_KEEPER_FEE_BPS) {
    throw new Error(`--keeper-fee-bps must be a whole number from 0 to ${MAX_KEEPER_FEE_BPS}`);
  }
  const client = new TerpClient(connection);

  const existing = await client.fetchConfig();
  if (existing) {
    console.log(`config already exists at ${configPda().toBase58()}`);
    console.log(`  admin    ${existing.admin.toBase58()}${existing.admin.equals(admin.publicKey) ? "" : "   <-- NOT your key"}`);
    console.log(`  keeper   ${existing.keeper.toBase58()}`);
    console.log(`  treasury ${existing.treasury.toBase58()}`);
    console.log(`  keeper fee ${existing.keeperFeeBps / 100}% of converted tax, for new launches`);
    return;
  }

  // exact-input swaps only: the program fixes how many tokens a conversion sells
  const swapDiscriminators = [sighash("swap"), sighash("swap2")];
  await reviewAndSend(connection, {
    title: "Initialise protocol config",
    payer: admin,
    effects: [
      `admin = ${admin.publicKey.toBase58()} (can rotate admin/keeper/treasury, list leveraged assets, pause risk-increasing actions; cannot move funds)`,
      `keeper = ${keeper.toBase58()} (the only key that may convert tax and deploy it; sizes, prices and destinations are fixed by the program; cannot withdraw)`,
      `treasury = ${treasury.toBase58()} (receives the keeper fee, and residual USDC of launches whose supply reached zero)`,
      `keeper fee = ${keeperFeeBps / 100}% of every tax conversion, paid to the treasury; each launch keeps the rate it was created with`,
      "creates the treasury's associated USDC account if it does not exist",
      "collection, deleveraging, redemption and claim payouts stay callable by anyone",
      `swap program = Meteora DLMM ${DLMM_PROGRAM_ID.toBase58()}, instructions swap and swap2 (immutable)`,
      "cost: rent for one small account (two if the treasury's USDC account is new), paid by the admin",
    ],
    instructions: [
      createUsdcAccountIx(admin.publicKey, treasury),
      await client.initConfigIx(admin.publicKey, {
        keeper,
        treasury,
        keeperFeeBps,
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
