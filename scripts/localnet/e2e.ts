/**
 * LOCAL SIMULATION ONLY. Runs a whole launch against a local validator that carries the real
 * Meteora DLMM program (see start-validator.sh):
 *
 *   1. config and market listing
 *   2. a transfer-tax mint and its launch
 *   3. a DLMM pool seeded with TOKENS ONLY, as positions owned by the launch vault and locked
 *   4. a buy, the tax it leaves behind, the sweep, and the keeper's sale through the real pool
 *   5. attempts by the creator to take the liquidity back
 *
 * It refuses to run against mainnet. USDC here is a MOCK mint the test can print.
 */
import {
  DLMM_PROGRAM_ID,
  SOL_MARKET,
  TerpClient,
  USDC_MINT,
  buildCreateMintIxs,
  createUsdcAccountIx,
  launchAddresses,
  launchPda,
  retargetInstructions,
  tokenAta,
  usdcAta,
} from "@terp/sdk";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getTransferFeeAmount,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { MAINNET_GENESIS } from "../lib";
import { loadLocalKey } from "./keys";

const dlmmModule = createRequire(import.meta.url)("@meteora-ag/dlmm");
const DLMM = dlmmModule.default ?? dlmmModule;
const { ActivationType, CollectFeeMode, deriveCustomizablePermissionlessLbPair, getPriceOfBinByBinId } = dlmmModule;

const DECIMALS = 6;
const TOKEN = 10n ** BigInt(DECIMALS);
const USDC = 1_000_000n;
const SUPPLY = 1_000_000_000n * TOKEN;
const POOL_ALLOCATION = (SUPPLY * 80n) / 100n;
const TRANSFER_FEE_BPS = 300;
const BIN_STEP_BPS = Number(process.env.BIN_STEP_BPS ?? 200);
const POOL_FEE_BPS = 100;
/** USDC per token at the bottom and the top of the seeded range. */
const START_PRICE = Number(process.env.START_PRICE ?? 0.00001);
const TOP_PRICE = Number(process.env.TOP_PRICE ?? 0.0005);
const CURVATURE = Number(process.env.CURVATURE ?? 0.6);
const ACTIVATION_DELAY_SLOTS = Number(process.env.ACTIVATION_DELAY_SLOTS ?? 150);
const U64_MAX = new BN("18446744073709551615");

const sighash = (name: string) => [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];
const connection = new Connection(process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const client = new TerpClient(connection);

async function send(label: string, payer: Keypair, ixs: TransactionInstruction[], signers: Signer[] = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const budget = ixs.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
    ? []
    : [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...budget, ...ixs],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer, ...signers]);
  const size = transaction.serialize().length;
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false });
  if (simulation.value.err) {
    const error = new Error(`${label}: ${JSON.stringify(simulation.value.err)}`);
    (error as any).logs = simulation.value.logs ?? [];
    throw error;
  }
  const signature = await connection.sendTransaction(transaction, { skipPreflight: true });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`${label}: ${JSON.stringify(result.value.err)}`);
  console.log(`  ok  ${label}  (${size} bytes, ${simulation.value.unitsConsumed} CU)`);
  if (process.env.DEBUG_BALANCES && label.includes("claim")) {
    const meta = (await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))?.meta;
    const keys = message.staticAccountKeys;
    for (const post of meta?.postTokenBalances ?? []) {
      const pre = meta?.preTokenBalances?.find((b) => b.accountIndex === post.accountIndex);
      const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
      if (delta !== 0n) console.log(`        ${keys[post.accountIndex].toBase58()} owner ${post.owner?.slice(0, 8)} mint ${post.mint.slice(0, 4)}: ${delta}`);
    }
  }
}

const retargeter = (pairs: [PublicKey, PublicKey][]) => (ix: TransactionInstruction) => retargetInstructions([ix], pairs)[0];

/** Runs something that must fail; returns the failure's last program log lines. */
async function mustFail(label: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
  } catch (error: any) {
    const logs: string[] = error.logs ?? [];
    const reason = logs.filter((l) => /Error|failed|custom/i.test(l)).slice(-2).join(" | ") || String(error.message).slice(0, 200);
    console.log(`  ok  ${label}: REJECTED (${reason.slice(0, 260)})`);
    return true;
  }
  console.log(`  !!  ${label}: SUCCEEDED, which it must not`);
  return false;
}

const tokenBalance = async (account: PublicKey, programId = TOKEN_2022_PROGRAM_ID) =>
  (await getAccount(connection, account, "confirmed", programId)).amount;

async function main() {
  if ((await connection.getGenesisHash()) === MAINNET_GENESIS) throw new Error("this is mainnet; the local e2e never runs there");
  const [admin, keeper, treasury, creator, buyer, usdcAuthority] = [
    "admin",
    "keeper",
    "treasury",
    "creator",
    "buyer",
    "usdc-authority",
  ].map(loadLocalKey);
  for (const key of [admin, keeper, creator, buyer, usdcAuthority]) {
    const signature = await connection.requestAirdrop(key.publicKey, 100 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, "confirmed");
  }

  console.log("1. protocol config and market");
  if (!(await client.fetchConfig())) {
    await send("init_config (keeper fee 3%, swap program = real DLMM)", admin, [
      createUsdcAccountIx(admin.publicKey, treasury.publicKey),
      await client.initConfigIx(admin.publicKey, {
        keeper: keeper.publicKey,
        treasury: treasury.publicKey,
        keeperFeeBps: 300,
        swapProgram: DLMM_PROGRAM_ID,
        swapDiscriminators: [sighash("swap"), sighash("swap2")],
      }),
    ]);
    await send("add_market SOL", admin, [
      await client.addMarketIx(admin.publicKey, { ...SOL_MARKET, tickSize: BigInt(SOL_MARKET.tickSize) }),
    ]);
  }

  console.log("2. mint and launch");
  const mintKey = Keypair.generate();
  const mint = mintKey.publicKey;
  const launchAddress = launchPda(mint);
  console.log(`  mint ${mint.toBase58()}`);
  const activeId: number = DLMM.getBinIdFromPrice(START_PRICE * 10 ** (6 - DECIMALS), BIN_STEP_BPS, false);
  const startPrice = Number(getPriceOfBinByBinId(activeId, BIN_STEP_BPS).toString());
  // what a sale into the pool realizes at the start: price less the transfer tax and the pool fee
  const initialPrice = BigInt(Math.floor(startPrice * 1e12 * ((10_000 - TRANSFER_FEE_BPS - POOL_FEE_BPS) / 10_000)));
  await send(
    "create mint (3% transfer tax, withheld authority = launch vault) + create_launch",
    creator,
    [
      ...(await buildCreateMintIxs(connection, creator.publicKey, mint, {
        name: "Local Test",
        symbol: "LOCAL",
        uri: "",
        decimals: DECIMALS,
        totalSupply: SUPPLY,
        transferFeeBps: TRANSFER_FEE_BPS,
      } as any)),
      await client.createLaunchIx(creator.publicKey, mint, {
        assetId: SOL_MARKET.assetId,
        totalSupply: SUPPLY,
        creatorAllocation: SUPPLY - POOL_ALLOCATION,
        poolAllocation: POOL_ALLOCATION,
        initialPrice,
        minConvertTokens: SUPPLY / 100_000n,
        maxConvertTokens: SUPPLY / 1_000n,
        convertCooldownSlots: 10n,
        maxPriceDropBps: 1000,
        minDepositUsdc: 10n * USDC,
        minRedeemTokens: TOKEN,
      }),
    ],
    [mintKey],
  );

  console.log("3. pool, seeded with tokens only");
  // DLMM requires the pool creator to hold a non-zero balance of both tokens ("launch owner
  // proof"); the creator needs a little USDC in the wallet, but none of it is deposited.
  await send("mint 1 MOCK USDC to the creator", usdcAuthority, [
    createUsdcAccountIx(usdcAuthority.publicKey, creator.publicKey),
    createMintToInstruction(USDC_MINT, usdcAta(creator.publicKey), usdcAuthority.publicKey, USDC),
  ]);
  const [pool] = deriveCustomizablePermissionlessLbPair(mint, USDC_MINT, DLMM_PROGRAM_ID);
  // Trading opens at the activation slot. Positions can only be created on behalf of another
  // owner before that, so the pool is created first, seeded, and opens afterwards.
  const activationPoint = new BN((await connection.getSlot("confirmed")) + ACTIVATION_DELAY_SLOTS);
  const createPair = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    new BN(BIN_STEP_BPS),
    mint,
    USDC_MINT,
    new BN(activeId),
    new BN(POOL_FEE_BPS),
    ActivationType.Slot,
    false,
    creator.publicKey,
    activationPoint,
    false,
    undefined,
    CollectFeeMode.OnlyY, // the pool's swap fee is always taken in USDC
  );
  await send("create DLMM pool + set_pool", creator, [
    ...createPair.instructions,
    await client.setPoolIx(creator.publicKey, mint, pool),
  ]);

  let dlmm = await DLMM.create(connection, pool);
  const base = Keypair.generate();
  const lock = process.env.LOCK_RELEASE_POINT ? new BN(process.env.LOCK_RELEASE_POINT) : U64_MAX;
  // The SDK derives the position owner's token account as if the owner were a wallet, which a
  // PDA is not. So the seeding is built for a placeholder owner and then pointed at the vault.
  const placeholder = Keypair.generate().publicKey;
  const seed = await dlmm.seedLiquidity(
    placeholder,
    new BN(POOL_ALLOCATION.toString()),
    CURVATURE,
    START_PRICE,
    TOP_PRICE,
    base.publicKey,
    creator.publicKey,
    launchAddress, // fee owner
    creator.publicKey, // operator: deposits the tokens
    lock,
    true,
  );
  // position owner: the launch vault PDA, which has no instruction to withdraw
  const retarget = retargeter([
    [placeholder, launchAddress],
    [tokenAta(placeholder, mint), tokenAta(launchAddress, mint)],
  ]);
  seed.sendPositionOwnerTokenProveIxs = seed.sendPositionOwnerTokenProveIxs.map(retarget);
  seed.initializeBinArraysAndPositionIxs = seed.initializeBinArraysAndPositionIxs.map((ixs: TransactionInstruction[]) => ixs.map(retarget));
  seed.addLiquidityIxs = seed.addLiquidityIxs.map((ixs: TransactionInstruction[]) => ixs.map(retarget));
  let transactions = 0;
  if (seed.sendPositionOwnerTokenProveIxs.length > 0) {
    await send("prove position owner (1 token atom to the vault's token account)", creator, seed.sendPositionOwnerTokenProveIxs);
    transactions += 1;
  }
  for (const [i, ixs] of seed.initializeBinArraysAndPositionIxs.entries()) {
    await send(`init bin arrays / positions ${i + 1}/${seed.initializeBinArraysAndPositionIxs.length}`, creator, ixs, [base]);
    transactions += 1;
  }
  for (const [i, ixs] of seed.addLiquidityIxs.entries()) {
    await send(`deposit tokens ${i + 1}/${seed.addLiquidityIxs.length}`, creator, ixs);
    transactions += 1;
  }
  console.log(`  seeding took ${transactions} transaction(s)`);

  dlmm = await DLMM.create(connection, pool);
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(launchAddress);
  const reserveX = await tokenBalance(dlmm.lbPair.reserveX);
  const reserveY = await tokenBalance(dlmm.lbPair.reserveY, TOKEN_PROGRAM_ID);
  console.log(`  pool holds ${reserveX / TOKEN} tokens and ${reserveY} USDC atoms; ${userPositions.length} position(s) owned by the vault`);
  for (const position of userPositions) {
    const data = position.positionData;
    console.log(
      `    position ${position.publicKey.toBase58().slice(0, 8)}: bins ${data.lowerBinId}..${data.upperBinId}, owner ${data.owner.toBase58().slice(0, 8)}, ` +
        `operator ${position.positionData.operator?.toBase58?.().slice(0, 8) ?? "?"}, lock release ${data.lockReleasePoint?.toString?.() ?? "?"}`,
    );
  }
  console.log(`  creator still holds ${(await tokenBalance(tokenAta(creator.publicKey, mint))) / TOKEN} tokens`);

  console.log("4. a buy, its tax, and the keeper's sale through the real pool");
  while ((await connection.getSlot("confirmed")) <= activationPoint.toNumber()) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  console.log(`  pool activated at slot ${activationPoint.toString()}`);
  const buyerUsdc = usdcAta(buyer.publicKey);
  await send("mint MOCK USDC to the buyer", usdcAuthority, [
    createUsdcAccountIx(usdcAuthority.publicKey, buyer.publicKey),
    createMintToInstruction(USDC_MINT, buyerUsdc, usdcAuthority.publicKey, 5_000n * USDC),
  ]);
  const spend = new BN((2_000n * USDC).toString());
  const buyArrays = await dlmm.getBinArrayForSwap(false);
  const buyQuote = dlmm.swapQuote(spend, false, new BN(100), buyArrays);
  const buy = await dlmm.swap({
    inToken: USDC_MINT,
    outToken: mint,
    inAmount: spend,
    minOutAmount: buyQuote.minOutAmount,
    lbPair: pool,
    user: buyer.publicKey,
    binArraysPubkey: buyQuote.binArraysPubkey,
  });
  await send("buyer swaps 2,000 USDC for tokens", buyer, buy.instructions);
  const buyerTokens = await getAccount(connection, tokenAta(buyer.publicKey, mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  const withheld = getTransferFeeAmount(buyerTokens)?.withheldAmount ?? 0n;
  console.log(`  buyer received ${buyerTokens.amount / TOKEN} tokens; ${withheld / TOKEN} more were withheld as tax`);

  const launch = (await client.fetchLaunch(mint))!;
  const sources = await client.findWithheldAccounts(mint);
  await send(`collect_tax from ${sources.length} account(s)`, keeper, [await client.collectTaxIx(keeper.publicKey, launch, sources)]);
  const taxTokens = await tokenBalance(launch.taxAccount);
  console.log(`  vault tax account holds ${taxTokens / TOKEN} tokens`);

  dlmm = await DLMM.create(connection, pool);
  const batch = taxTokens < launch.maxConvertTokens ? taxTokens : launch.maxConvertTokens;
  const taxAuthority = launchAddresses(mint).taxAuthority;
  const sellArrays = await dlmm.getBinArrayForSwap(true);
  const sellQuote = dlmm.swapQuote(new BN(batch.toString()), true, new BN(100), sellArrays);
  const sell = await dlmm.swap({
    inToken: mint,
    outToken: USDC_MINT,
    inAmount: new BN(batch.toString()),
    minOutAmount: sellQuote.minOutAmount,
    lbPair: pool,
    user: taxAuthority,
    binArraysPubkey: sellQuote.binArraysPubkey,
  });
  const swapIx = (sell.instructions as TransactionInstruction[]).filter((ix) => ix.programId.equals(DLMM_PROGRAM_ID));
  if (swapIx.length !== 1) throw new Error(`expected one DLMM instruction, got ${swapIx.length}`);
  await send(`convert_tax: sell ${batch / TOKEN} tokens through DLMM`, keeper, [
    await client.convertTaxIx(keeper.publicKey, launch, batch, swapIx[0], treasury.publicKey),
  ]);
  const vaultUsdc = await getAccount(connection, launch.vaultUsdc);
  const treasuryUsdc = await getAccount(connection, usdcAta(treasury.publicKey));
  console.log(
    `  vault received ${Number(vaultUsdc.amount) / 1e6} USDC, treasury ${Number(treasuryUsdc.amount) / 1e6} USDC ` +
      `(${((Number(treasuryUsdc.amount) * 100) / Number(vaultUsdc.amount + treasuryUsdc.amount)).toFixed(2)}% keeper fee); pool quote was ${Number(sellQuote.outAmount) / 1e6}`,
  );

  console.log("5. can the creator take the liquidity back?");
  dlmm = await DLMM.create(connection, pool);
  const positions = (await dlmm.getPositionsByUserAndLbPair(launchAddress)).userPositions;
  const first = positions[0];
  const creatorUsdcIx = createAssociatedTokenAccountIdempotentInstruction(
    creator.publicKey,
    usdcAta(creator.publicKey),
    creator.publicKey,
    USDC_MINT,
  );
  let locked = true;
  locked &&= await mustFail("creator (operator) removes liquidity", async () => {
    const removal = await dlmm.removeLiquidity({
      user: creator.publicKey,
      position: first.publicKey,
      fromBinId: first.positionData.lowerBinId,
      toBinId: first.positionData.upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: false,
    });
    const txs = Array.isArray(removal) ? removal : [removal];
    for (const tx of txs) await send("remove liquidity", creator, [creatorUsdcIx, ...tx.instructions]);
  });
  locked &&= await mustFail("creator (operator) removes liquidity and closes the position", async () => {
    const removal = await dlmm.removeLiquidity({
      user: creator.publicKey,
      position: first.publicKey,
      fromBinId: first.positionData.lowerBinId,
      toBinId: first.positionData.upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });
    const txs = Array.isArray(removal) ? removal : [removal];
    for (const tx of txs) await send("remove and close", creator, [creatorUsdcIx, ...tx.instructions]);
  });
  const after = await tokenBalance(dlmm.lbPair.reserveX);
  console.log(`  pool still holds ${after / TOKEN} tokens`);

  console.log("6. the pool's swap fees: can they be claimed, and where do they go?");
  const vaultBefore = (await getAccount(connection, launch.vaultUsdc)).amount;
  const vaultTokensBefore = await tokenBalance(tokenAta(launchAddress, mint));
  const earning = positions.filter((p: any) => !p.positionData.feeY.isZero() || !p.positionData.feeX.isZero());
  console.log(`  ${earning.length} position(s) have unclaimed fees`);
  for (const position of earning) {
    console.log(`    ${position.publicKey.toBase58().slice(0, 8)}: ${Number(position.positionData.feeY) / 1e6} USDC, ${position.positionData.feeX.toString()} token atoms`);
  }
  // The SDK builds a claim that pays the position's fee owner, which is the vault. `redirect`
  // swaps those destinations for other accounts, to see whether the program allows it.
  const claim = async (label: string, sender: Keypair, redirect: [PublicKey, PublicKey][] = []) => {
    const stand = Keypair.generate().publicKey;
    const claims = await dlmm.claimAllSwapFee({ owner: stand, positions: earning });
    if (claims.length === 0) throw new Error("the SDK built no claim");
    const retarget = retargeter([[stand, sender.publicKey], ...redirect]);
    for (const tx of claims) {
      const ixs = (tx.instructions as TransactionInstruction[]).filter((ix) => ix.programId.equals(DLMM_PROGRAM_ID)).map(retarget);
      if (!ixs.some((ix) => ix.keys.some((k) => k.pubkey.equals(redirect[0]?.[1] ?? launch.vaultUsdc)))) {
        throw new Error("the claim does not name the expected USDC destination");
      }
      await send(label, sender, ixs);
    }
  };
  locked &&= await mustFail("creator (operator) claims the pool fees to their own wallet", () =>
    claim("claim to the creator's wallet", creator, [
      [launch.vaultUsdc, usdcAta(creator.publicKey)],
      [tokenAta(launchAddress, mint), tokenAta(creator.publicKey, mint)],
    ]),
  );
  locked &&= await mustFail("a stranger claims the pool fees, even into the vault", () => claim("claim by a stranger", buyer));
  await claim("the creator (operator) claims the pool fees into the vault", creator);
  const vaultAfter = (await getAccount(connection, launch.vaultUsdc)).amount;
  console.log(`  vault USDC ${Number(vaultBefore) / 1e6} -> ${Number(vaultAfter) / 1e6}; vault token account ${vaultTokensBefore} -> ${await tokenBalance(tokenAta(launchAddress, mint))} atoms`);

  console.log(locked ? "\nRESULT: liquidity is locked; the creator could not withdraw it." : "\nRESULT: NOT LOCKED. See above.");
  if (!locked) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  for (const line of (error as any).logs ?? []) console.error("   ", line);
  process.exit(1);
});
