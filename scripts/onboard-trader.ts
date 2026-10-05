/**
 * Gives a launch its Phoenix trader account and asks Phoenix to enable it.
 *
 *   RPC_URL=... PAYER_KEYPAIR=~/.config/solana/id.json \
 *   pnpm --filter @terp/scripts onboard-trader --mint <launch mint> [--dry-run]
 *
 * Step 1 (`register_trader`, on-chain) creates the trader account whose authority is the launch
 * PDA. It pays rent for the trader account and the vault's canonical token account.
 *
 * Step 2 uses Phoenix's builder onboarding API: Phoenix returns the instructions that enable the
 * trader's capabilities, the payer signs as fee payer, and Phoenix's onboarder co-signs and
 * submits. This step depends on Phoenix: until it succeeds, deposits and orders for the launch
 * are rejected by the exchange. The launch PDA never signs anything here.
 */
import { TerpClient, buildOnboardingIxs, fetchTraderHeader, launchAddresses, submitOnboarding } from "@terp/sdk";
import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ask, connect, env, isMainnet, loadKeypair, pubkeyArg, reviewAndSend } from "./lib";

async function main() {
  const connection = connect();
  const payer = loadKeypair(env("PAYER_KEYPAIR"));
  const mint = pubkeyArg("mint");
  const client = new TerpClient(connection);
  const launch = await client.fetchLaunch(mint);
  if (!launch) throw new Error(`no launch for mint ${mint.toBase58()}`);
  const addresses = launchAddresses(mint);

  if (!launch.traderAccount) {
    const sent = await reviewAndSend(connection, {
      title: "Register the launch's Phoenix trader account",
      payer,
      effects: [
        `creates Phoenix trader ${addresses.traderAccount.toBase58()} with authority = launch PDA ${addresses.launch.toBase58()}`,
        "creates the vault's canonical collateral token account",
        "cost: rent for both accounts, paid by the payer; no USDC or tokens move",
      ],
      instructions: [await client.registerTraderIx(payer.publicKey, mint)],
    });
    if (!sent) return;
  } else {
    console.log(`trader already registered: ${launch.traderAccount.toBase58()}`);
  }

  const header = await fetchTraderHeader(connection, addresses.traderAccount);
  if (header?.isOnboarded) {
    console.log("Phoenix has already enabled this trader. Nothing to do.");
    return;
  }

  console.log("\n=== Phoenix onboarding (Phoenix API, co-signed by Phoenix) ===");
  const { instructions, raw } = await buildOnboardingIxs(addresses.launch, payer.publicKey);
  console.log(`Phoenix onboarder: ${raw.traderOnboarder ?? "n/a"}; ${instructions.length} instruction(s)`);
  for (const ix of instructions) console.log(`  - program ${ix.programId.toBase58()}, ${ix.keys.length} account(s)`);
  if (process.argv.includes("--dry-run")) {
    console.log("--dry-run: not signing or submitting");
    return;
  }
  const phrase = (await isMainnet(connection)) ? "send to mainnet" : "send";
  if ((await ask(`Type "${phrase}" to sign as fee payer and submit through Phoenix, anything else to abort: `)) !== phrase) {
    console.log("aborted; nothing was sent");
    return;
  }

  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const transaction = new VersionedTransaction(
    new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(),
  );
  transaction.sign([payer]);
  const { signature } = await submitOnboarding(
    Buffer.from(transaction.serialize()).toString("base64"),
    addresses.launch,
    payer.publicKey,
  );
  console.log(`submitted by Phoenix: ${signature}`);
  const after = await fetchTraderHeader(connection, addresses.traderAccount);
  console.log(after?.isOnboarded ? "trader is enabled" : "trader is not enabled yet; check the signature and rerun");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
