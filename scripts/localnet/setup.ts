/**
 * LOCAL SIMULATION ONLY. Prepares `.localnet/` for `start-validator.sh`:
 *
 *   - test keypairs (admin, keeper, treasury, creator, buyer, USDC authority);
 *   - a copy of mainnet's USDC mint whose mint authority is replaced by the test authority, so
 *     the local run can mint itself USDC. This account is a MOCK and exists only on the local
 *     validator.
 *
 * Reads one account from mainnet (read-only). Sends nothing anywhere.
 */
import { USDC_MINT } from "@terp/sdk";
import { Connection, Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocalKey } from "./keys";

export const LOCALNET_DIR = resolve(import.meta.dirname, "../../.localnet");
export const ROLES = ["admin", "keeper", "treasury", "creator", "buyer", "usdc-authority"] as const;

async function main() {
  mkdirSync(LOCALNET_DIR, { recursive: true });
  for (const role of ROLES) {
    const path = resolve(LOCALNET_DIR, `${role}.json`);
    if (!existsSync(path)) writeFileSync(path, JSON.stringify([...Keypair.generate().secretKey]));
  }
  const authority = loadLocalKey("usdc-authority").publicKey;

  const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const mint = await mainnet.getAccountInfo(USDC_MINT);
  if (!mint) throw new Error("could not read the USDC mint from mainnet");
  const data = Buffer.from(mint.data);
  // SPL mint layout: COption<Pubkey> mint_authority at offset 0 (4-byte tag, 32-byte key)
  data.writeUInt32LE(1, 0);
  authority.toBuffer().copy(data, 4);
  writeFileSync(
    resolve(LOCALNET_DIR, "usdc-mint.json"),
    JSON.stringify({
      pubkey: USDC_MINT.toBase58(),
      account: {
        lamports: mint.lamports,
        data: [data.toString("base64"), "base64"],
        owner: mint.owner.toBase58(),
        executable: false,
        rentEpoch: 0,
        space: data.length,
      },
    }),
  );
  console.log(`wrote ${LOCALNET_DIR}: test keys and a MOCK USDC mint (authority ${authority.toBase58()})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
