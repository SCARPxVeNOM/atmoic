/**
 * DFBA (Distributed Fair-Price Batch Auction) edge case tests.
 *
 * Covers: empty batch, price cap, OI guards, partial fills, PSF accrual,
 * crank fee logic, multi-shard merging, and pause state.
 *
 * Build: anchor build --no-idl -- --features mock-oracle,dfba
 * Run:   anchor test --skip-build
 */

import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  DEFAULT_LIQUIDATION_THRESHOLD_BPS,
  DEFAULT_MAX_LEVERAGE,
  DEFAULT_MAX_TVL,
  DEFAULT_PROTOCOL_FEE_BPS,
  SOL_DECIMALS,
  USDC_DECIMALS,
} from "./helpers/ids";
import {
  buildInitializeIx,
  buildUpdateConfigIx,
  buildSetTestConfigIx,
  buildInitQueueShardIx,
  buildPlaceOrderIx,
  buildExecuteBatchIx,
  buildCancelOrderIx,
  decodeGlobalConfig,
  findConfigPda,
  findQueueShardPda,
} from "./helpers/program";
import {
  airdrop,
  createPdaOwnedTokenAccount,
  createTestMint,
  mintToken,
} from "./helpers/setup";
import { createMockOracleAccount } from "./helpers/oracle";

const RESERVE_USDC = 100_000n * 10n ** BigInt(USDC_DECIMALS);

async function sendTx(
  conn: Connection, tx: Transaction, signers: Keypair[],
): Promise<string> {
  return sendAndConfirmTransaction(conn, tx, signers);
}

async function expectError(
  conn: Connection, tx: Transaction, signers: Keypair[], errorCode: number,
): Promise<void> {
  try {
    await sendTx(conn, tx, signers);
    expect.fail("Expected transaction to fail");
  } catch (e: any) {
    const msg = e.message ?? String(e);
    expect(msg).to.include(`0x${errorCode.toString(16)}`);
  }
}

describe("dfba_edge_cases", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  const admin = Keypair.generate();
  const bidder = Keypair.generate();
  const asker = Keypair.generate();
  const bidder2 = Keypair.generate();
  const cranker = Keypair.generate();
  const feeRecipient = Keypair.generate();

  let solMint: PublicKey, usdcMint: PublicKey;
  let solVault: PublicKey, usdcReserve: PublicKey;
  let oracleKp: Keypair;

  const [configPda] = findConfigPda();

  // Queue shards — market=1 to avoid collision with atomic_perps_extended (market=0)
  const [bidShard0] = findQueueShardPda(1, 0, 0);
  const [bidShard1] = findQueueShardPda(1, 0, 1);
  const [askShard0] = findQueueShardPda(1, 1, 0);

  before("bootstrap", async () => {
    await Promise.all([
      airdrop(connection, admin.publicKey, 50),
      airdrop(connection, bidder.publicKey, 10),
      airdrop(connection, asker.publicKey, 10),
      airdrop(connection, bidder2.publicKey, 10),
      airdrop(connection, cranker.publicKey, 10),
      airdrop(connection, feeRecipient.publicKey, 1),
    ]);

    solMint = await createTestMint(connection, admin, SOL_DECIMALS);
    usdcMint = await createTestMint(connection, admin, USDC_DECIMALS);

    solVault = await createPdaOwnedTokenAccount(connection, admin, solMint);
    usdcReserve = await createPdaOwnedTokenAccount(connection, admin, usdcMint);
    await mintToken(connection, admin, usdcMint, usdcReserve, admin, RESERVE_USDC);

    oracleKp = await createMockOracleAccount(connection, admin, 150_000_000n, 10_000n);

    // Initialize protocol
    const initIx = buildInitializeIx({
      authority: admin.publicKey,
      solVault,
      usdcReserve,
      params: {
        feeRecipient: feeRecipient.publicKey,
        pythSolFeed: oracleKp.publicKey,
        solMint,
        usdcMint,
        maxLeverage: DEFAULT_MAX_LEVERAGE,
        liquidationThreshold: DEFAULT_LIQUIDATION_THRESHOLD_BPS,
        protocolFeeBps: DEFAULT_PROTOCOL_FEE_BPS,
        maxTvl: DEFAULT_MAX_TVL,
      },
    });
    await sendTx(connection, new Transaction().add(initIx), [admin]);

    // Set high USDC reserve for OI headroom
    const reserveIx = buildUpdateConfigIx({
      authority: admin.publicKey,
      totalUsdcReserve: 100_000_000_000n,
    });
    await sendTx(connection, new Transaction().add(reserveIx), [admin]);

    // Init queue shards (market=1 to isolate from other test files)
    for (const args of [
      { market: 1, side: 0, shard: 0 },
      { market: 1, side: 0, shard: 1 },
      { market: 1, side: 1, shard: 0 },
    ]) {
      const ix = buildInitQueueShardIx({ payer: admin.publicKey, ...args });
      await sendTx(connection, new Transaction().add(ix), [admin]);
    }
  });

  // ---- Helpers ----

  async function placeBid(user: Keypair, shard: PublicKey, price: bigint, size: bigint) {
    const ix = buildPlaceOrderIx({ user: user.publicKey, queueShard: shard, price, size });
    await sendTx(connection, new Transaction().add(ix), [user]);
  }

  async function placeAsk(user: Keypair, shard: PublicKey, price: bigint, size: bigint) {
    const ix = buildPlaceOrderIx({ user: user.publicKey, queueShard: shard, price, size });
    await sendTx(connection, new Transaction().add(ix), [user]);
  }

  async function cancelOrder(user: Keypair, shard: PublicKey) {
    const ix = buildCancelOrderIx({ user: user.publicKey, queueShard: shard });
    await sendTx(connection, new Transaction().add(ix), [user]);
  }

  async function executeBatch(bidShards: PublicKey[], askShards: PublicKey[]) {
    const ix = buildExecuteBatchIx({
      cranker: cranker.publicKey,
      pythPriceFeed: oracleKp.publicKey,
      bidShards,
      askShards,
    });
    await sendTx(connection, new Transaction().add(ix), [cranker]);
  }

  function readShardCount(data: Buffer): number {
    return data.readUInt32LE(8);
  }

  function readOrderSize(data: Buffer, orderIndex: number): bigint {
    // Order layout within shard: disc(8) + header(4) + orders
    // Each order: user(32) + price(8) + size(8) + timestamp(8) = 56
    const off = 12 + orderIndex * 56;
    return data.readBigUInt64LE(off + 40); // size at offset 40 within order
  }

  async function resetOi() {
    await sendTx(connection, new Transaction().add(
      buildSetTestConfigIx({
        authority: admin.publicKey,
        totalLongOi: 0n,
        totalShortOi: 0n,
      }),
    ), [admin]);
  }

  async function setReserve(amount: bigint) {
    await sendTx(connection, new Transaction().add(
      buildUpdateConfigIx({ authority: admin.publicKey, totalUsdcReserve: amount }),
    ), [admin]);
  }

  // ===================================================================
  // 1. Empty batch (non-crossing orders) -- crank not paid
  // ===================================================================

  it("empty batch (no crossing) doesn't pay crank", async () => {
    // Bid at $149.60, ask at $150.40 -- both within Pyth cap but non-crossing
    await placeBid(bidder, bidShard0, 149_600_000n, 10_000_000n);
    await placeAsk(asker, askShard0, 150_400_000n, 10_000_000n);

    const cfgBefore = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );
    const configLamportsBefore = (await connection.getAccountInfo(configPda))!.lamports;

    await executeBatch([bidShard0], [askShard0]);

    // Orders remain in shards (not consumed)
    const bidAcct = await connection.getAccountInfo(bidShard0);
    expect(readShardCount(bidAcct!.data as Buffer)).to.equal(1);
    const askAcct = await connection.getAccountInfo(askShard0);
    expect(readShardCount(askAcct!.data as Buffer)).to.equal(1);

    // OI unchanged
    const cfgAfter = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );
    expect(cfgAfter.totalLongOi).to.equal(cfgBefore.totalLongOi);
    expect(cfgAfter.totalShortOi).to.equal(cfgBefore.totalShortOi);

    // Config lamports unchanged (no crank payment)
    const configLamportsAfter = (await connection.getAccountInfo(configPda))!.lamports;
    expect(configLamportsAfter).to.equal(configLamportsBefore);

    // Cleanup
    await cancelOrder(bidder, bidShard0);
    await cancelOrder(asker, askShard0);
  });

  // ===================================================================
  // 2. Price cap filters orders outside +/-0.3% of Pyth
  // ===================================================================

  it("price cap filters orders outside +/-0.3% of Pyth", async () => {
    // Pyth = $150. Cap = +/-0.3% = +/-$0.45. Range = [$149.55, $150.45].
    // Bid at $151 and ask at $149 -- both outside cap, filtered out, no match.
    await placeBid(bidder, bidShard0, 151_000_000n, 10_000_000n);
    await placeAsk(asker, askShard0, 149_000_000n, 10_000_000n);

    await executeBatch([bidShard0], [askShard0]);

    // Orders remain (not consumed -- filtered by price cap)
    const bidAcct = await connection.getAccountInfo(bidShard0);
    expect(readShardCount(bidAcct!.data as Buffer)).to.equal(1);
    const askAcct = await connection.getAccountInfo(askShard0);
    expect(readShardCount(askAcct!.data as Buffer)).to.equal(1);

    await cancelOrder(bidder, bidShard0);
    await cancelOrder(asker, askShard0);
  });

  // ===================================================================
  // 3. execute_batch rejects when paused
  // ===================================================================

  it("execute_batch rejects when paused", async () => {
    await placeBid(bidder, bidShard0, 150_000_000n, 10_000_000n);
    await placeAsk(asker, askShard0, 150_000_000n, 10_000_000n);

    // Pause protocol
    const pauseIx = buildUpdateConfigIx({ authority: admin.publicKey, isPaused: true });
    await sendTx(connection, new Transaction().add(pauseIx), [admin]);

    // Execute -> ProtocolPaused (6009)
    const ix = buildExecuteBatchIx({
      cranker: cranker.publicKey,
      pythPriceFeed: oracleKp.publicKey,
      bidShards: [bidShard0],
      askShards: [askShard0],
    });
    await expectError(connection, new Transaction().add(ix), [cranker], 6009);

    // Unpause and cleanup
    const unpauseIx = buildUpdateConfigIx({ authority: admin.publicKey, isPaused: false });
    await sendTx(connection, new Transaction().add(unpauseIx), [admin]);
    await cancelOrder(bidder, bidShard0);
    await cancelOrder(asker, askShard0);
  });

  // ===================================================================
  // 4. OI guard rejects batch exceeding reserve
  // ===================================================================

  it("OI guard rejects batch exceeding reserve", async () => {
    await resetOi();
    // Lower reserve so matched volume exceeds OI cap
    await setReserve(1_000_000n); // 1 USDC

    await placeBid(bidder, bidShard0, 150_000_000n, 5_000_000n);
    await placeAsk(asker, askShard0, 150_000_000n, 5_000_000n);

    // Execute -> TVLCapExceeded (6008): 0 + 5M > 1M
    const ix = buildExecuteBatchIx({
      cranker: cranker.publicKey,
      pythPriceFeed: oracleKp.publicKey,
      bidShards: [bidShard0],
      askShards: [askShard0],
    });
    await expectError(connection, new Transaction().add(ix), [cranker], 6008);

    // Restore and cleanup
    await setReserve(100_000_000_000n);
    await cancelOrder(bidder, bidShard0);
    await cancelOrder(asker, askShard0);
  });

  // ===================================================================
  // 5. Combined OI guard (long+short) enforced
  // ===================================================================

  it("combined OI guard (long+short) enforced", async () => {
    // Per-side passes but combined fails:
    // Reserve = 1M, longOi = 450K, shortOi = 450K
    // Match 100K -> per-side: 450K+100K=550K <= 1M OK
    // Combined: 450K+100K+450K+100K = 1100K > 1M FAIL
    await setReserve(1_000_000n);
    await sendTx(connection, new Transaction().add(
      buildSetTestConfigIx({
        authority: admin.publicKey,
        totalLongOi: 450_000n,
        totalShortOi: 450_000n,
      }),
    ), [admin]);

    await placeBid(bidder, bidShard0, 150_000_000n, 100_000n);
    await placeAsk(asker, askShard0, 150_000_000n, 100_000n);

    const ix = buildExecuteBatchIx({
      cranker: cranker.publicKey,
      pythPriceFeed: oracleKp.publicKey,
      bidShards: [bidShard0],
      askShards: [askShard0],
    });
    await expectError(connection, new Transaction().add(ix), [cranker], 6008);

    // Restore
    await resetOi();
    await setReserve(100_000_000_000n);
    await cancelOrder(bidder, bidShard0);
    await cancelOrder(asker, askShard0);
  });

  // ===================================================================
  // 6. Partial fill updates order size correctly
  // ===================================================================

  it("partial fill updates order size correctly", async () => {
    await resetOi();

    // Bid 20M, ask 10M at same price -> bid partially filled (10M remains)
    await placeBid(bidder, bidShard0, 150_000_000n, 20_000_000n);
    await placeAsk(asker, askShard0, 150_000_000n, 10_000_000n);

    await executeBatch([bidShard0], [askShard0]);

    // Ask fully consumed
    const askAcct = await connection.getAccountInfo(askShard0);
    expect(readShardCount(askAcct!.data as Buffer)).to.equal(0);

    // Bid partially filled: count=1, remaining size = 10M
    const bidAcct = await connection.getAccountInfo(bidShard0);
    const bidData = bidAcct!.data as Buffer;
    expect(readShardCount(bidData)).to.equal(1);
    expect(readOrderSize(bidData, 0)).to.equal(10_000_000n);

    await cancelOrder(bidder, bidShard0);
  });

  // ===================================================================
  // 7. PSF accrues from execute_batch
  // ===================================================================

  it("PSF accrues from execute_batch", async () => {
    await resetOi();

    const cfgBefore = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );

    // Match 10M at $150
    await placeBid(bidder, bidShard0, 150_000_000n, 10_000_000n);
    await placeAsk(asker, askShard0, 150_000_000n, 10_000_000n);
    await executeBatch([bidShard0], [askShard0]);

    const cfgAfter = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );

    // PSF = matched_vol * protocol_fee_bps / 10000 / 10
    // = 10_000_000 * 10 / 10000 / 10 = 1000
    const matchedVol = 10_000_000n;
    const expectedPsf = matchedVol * BigInt(DEFAULT_PROTOCOL_FEE_BPS) / 10_000n / 10n;
    const psfDelta = cfgAfter.psfBalance - cfgBefore.psfBalance;
    expect(psfDelta).to.equal(expectedPsf);
  });

  // ===================================================================
  // 8. Crank NOT paid when config has no excess lamports
  // ===================================================================

  it("crank NOT paid when config has no excess", async () => {
    await resetOi();

    const configLamportsBefore = (await connection.getAccountInfo(configPda))!.lamports;

    await placeBid(bidder, bidShard0, 150_000_000n, 10_000_000n);
    await placeAsk(asker, askShard0, 150_000_000n, 10_000_000n);
    await executeBatch([bidShard0], [askShard0]);

    // Config lamports unchanged -- no crank payment
    const configLamportsAfter = (await connection.getAccountInfo(configPda))!.lamports;
    expect(configLamportsAfter).to.equal(configLamportsBefore);
  });

  // ===================================================================
  // 9. Multi-shard batch merges orders from multiple bid shards
  // ===================================================================

  it("multi-shard batch merges orders", async () => {
    await resetOi();

    // Bid 5M in shard0 + bid 5M in shard1 -> total bid = 10M
    // Ask 10M in askShard0 -> should match all 10M
    await placeBid(bidder, bidShard0, 150_000_000n, 5_000_000n);
    await placeBid(bidder2, bidShard1, 150_000_000n, 5_000_000n);
    await placeAsk(asker, askShard0, 150_000_000n, 10_000_000n);

    const cfgBefore = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );

    // Execute with 2 bid shards
    const ix = buildExecuteBatchIx({
      cranker: cranker.publicKey,
      pythPriceFeed: oracleKp.publicKey,
      bidShards: [bidShard0, bidShard1],
      askShards: [askShard0],
    });
    await sendTx(connection, new Transaction().add(ix), [cranker]);

    // All shards empty (fully matched)
    const bid0 = await connection.getAccountInfo(bidShard0);
    expect(readShardCount(bid0!.data as Buffer)).to.equal(0);
    const bid1 = await connection.getAccountInfo(bidShard1);
    expect(readShardCount(bid1!.data as Buffer)).to.equal(0);
    const ask0 = await connection.getAccountInfo(askShard0);
    expect(readShardCount(ask0!.data as Buffer)).to.equal(0);

    // OI increased: long += 10M, short += 10M
    const cfgAfter = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );
    expect(cfgAfter.totalLongOi - cfgBefore.totalLongOi).to.equal(10_000_000n);
    expect(cfgAfter.totalShortOi - cfgBefore.totalShortOi).to.equal(10_000_000n);
  });

  // ===================================================================
  // 10. Crank paid 0.001 SOL when config has excess lamports
  // ===================================================================

  it("crank paid 0.001 SOL from config excess", async () => {
    await resetOi();

    // Fund config PDA with 5 SOL extra (well above rent + 1M crank fee)
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: configPda,
        lamports: 5 * LAMPORTS_PER_SOL,
      }),
    );
    await sendTx(connection, fundTx, [admin]);

    const configLamportsBefore = (await connection.getAccountInfo(configPda))!.lamports;

    await placeBid(bidder, bidShard0, 150_000_000n, 10_000_000n);
    await placeAsk(asker, askShard0, 150_000_000n, 10_000_000n);
    await executeBatch([bidShard0], [askShard0]);

    // Config lamports decreased by exactly 1_000_000 (0.001 SOL crank fee)
    const configLamportsAfter = (await connection.getAccountInfo(configPda))!.lamports;
    expect(configLamportsBefore - configLamportsAfter).to.equal(1_000_000);
  });
});
