/**
 * Boundary condition tests for Atomic Perps.
 *
 * Covers: leverage limits, health factor, OI cap, correlated cap,
 * dynamic spread, update_config, atomicity, and account audit.
 *
 * Build: anchor build --no-idl -- --features mock-oracle,dfba
 * Run:   anchor test --skip-build
 */

import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

import {
  DEFAULT_LIQUIDATION_THRESHOLD_BPS,
  DEFAULT_MAX_LEVERAGE,
  DEFAULT_MAX_TVL,
  DEFAULT_PROTOCOL_FEE_BPS,
  Side,
  SOL_DECIMALS,
  USDC_DECIMALS,
  JLP_DECIMALS,
} from "./helpers/ids";
import {
  buildAtomicOpenIx,
  buildAtomicCloseIx,
  buildInitializeIx,
  buildLiquidateIx,
  buildMigrateConfigV3Ix,
  buildUpdateConfigIx,
  decodeGlobalConfig,
  decodePosition,
  findConfigPda,
  findPositionPda,
} from "./helpers/program";
import {
  airdrop,
  createPdaOwnedTokenAccount,
  createTestMint,
  getOrCreateAta,
  mintToken,
} from "./helpers/setup";
import {
  createMockOracleAccount,
} from "./helpers/oracle";

// Constants
const RESERVE_USDC = 100_000n * 10n ** BigInt(USDC_DECIMALS);
const ONE_SOL = 10n ** BigInt(SOL_DECIMALS);
const USER_SOL = 10n * ONE_SOL;
const USER_USDC = 1_000_000n;   // 1 USDC buffer for close fee deficit
const USER_JLP = 100n * 10n ** BigInt(JLP_DECIMALS);

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

describe("boundary_conditions", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  // ---- Actors ----
  const admin = Keypair.generate();
  const u1  = Keypair.generate(); // leverage 10x accept (open+close)
  const u2  = Keypair.generate(); // leverage 10001 reject / spread below min reuse
  const u3  = Keypair.generate(); // implied leverage reject / max_leverage config reuse
  const u4  = Keypair.generate(); // health 10000 accept (open+close)
  const u5  = Keypair.generate(); // health 9999 reject / atomicity reuse
  const u6  = Keypair.generate(); // OI cap exact (open+close)
  const u7  = Keypair.generate(); // OI cap exceed reject
  const u8  = Keypair.generate(); // JLP correlated cap reject
  const u9  = Keypair.generate(); // JLP stress_active reject
  const u10 = Keypair.generate(); // fills suspended opener (open+close)
  const u11 = Keypair.generate(); // fills suspended victim
  const u12 = Keypair.generate(); // authority transfer target
  const feeRecipient = Keypair.generate();

  // ---- State ----
  let solMint: PublicKey, usdcMint: PublicKey, jlpMint: PublicKey, msolMint: PublicKey;
  let solVault: PublicKey, usdcReserve: PublicKey, jlpVault: PublicKey, msolVault: PublicKey;
  let feeUsdcAccount: PublicKey;
  let oracleKp: Keypair;

  const [configPda] = findConfigPda();

  // Per-user ATAs (SOL + USDC)
  const userAtas: Record<string, { sol: PublicKey; usdc: PublicKey }> = {};
  // JLP-specific ATAs
  let u8JlpAta: PublicKey, u8UsdcAta: PublicKey;
  let u9JlpAta: PublicKey, u9UsdcAta: PublicKey;

  // ---------- BOOTSTRAP ----------
  before("bootstrap validator state", async () => {
    const actors = [
      admin, u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11, u12, feeRecipient,
    ];
    await Promise.all(actors.map((a) => airdrop(connection, a.publicKey, 20)));

    // Mints
    solMint  = await createTestMint(connection, admin, SOL_DECIMALS);
    usdcMint = await createTestMint(connection, admin, USDC_DECIMALS);
    jlpMint  = await createTestMint(connection, admin, JLP_DECIMALS);
    msolMint = await createTestMint(connection, admin, SOL_DECIMALS);

    // PDA-owned vaults
    solVault   = await createPdaOwnedTokenAccount(connection, admin, solMint);
    usdcReserve = await createPdaOwnedTokenAccount(connection, admin, usdcMint);
    jlpVault   = await createPdaOwnedTokenAccount(connection, admin, jlpMint);
    msolVault  = await createPdaOwnedTokenAccount(connection, admin, msolMint);

    // Fund reserve + SOL vault
    await mintToken(connection, admin, usdcMint, usdcReserve, admin, RESERVE_USDC);
    await mintToken(connection, admin, solMint, solVault, admin, 100n * ONE_SOL);

    // Oracle at $150
    oracleKp = await createMockOracleAccount(connection, admin, 150_000_000n, 10_000n);

    // SOL-collateral user ATAs
    for (const u of [u1, u2, u3, u4, u5, u6, u7, u10, u11, u12]) {
      const sol  = await getOrCreateAta(connection, u, solMint, u.publicKey);
      const usdc = await getOrCreateAta(connection, u, usdcMint, u.publicKey);
      await mintToken(connection, admin, solMint, sol, admin, USER_SOL);
      await mintToken(connection, admin, usdcMint, usdc, admin, USER_USDC);
      userAtas[u.publicKey.toBase58()] = { sol, usdc };
    }

    // JLP user ATAs (u8, u9)
    u8JlpAta  = await getOrCreateAta(connection, u8, jlpMint, u8.publicKey);
    u8UsdcAta = await getOrCreateAta(connection, u8, usdcMint, u8.publicKey);
    await mintToken(connection, admin, jlpMint, u8JlpAta, admin, USER_JLP);
    await mintToken(connection, admin, usdcMint, u8UsdcAta, admin, USER_USDC);

    u9JlpAta  = await getOrCreateAta(connection, u9, jlpMint, u9.publicKey);
    u9UsdcAta = await getOrCreateAta(connection, u9, usdcMint, u9.publicKey);
    await mintToken(connection, admin, jlpMint, u9JlpAta, admin, USER_JLP);
    await mintToken(connection, admin, usdcMint, u9UsdcAta, admin, USER_USDC);

    // Fee recipient USDC ATA
    feeUsdcAccount = await getOrCreateAta(connection, admin, usdcMint, feeRecipient.publicKey);

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

    // Migrate to V3 (enables JLP/mSOL)
    const migIx = buildMigrateConfigV3Ix({
      authority: admin.publicKey,
      jlpMint,
      jlpVault,
      msolMint,
      msolVault,
      pythMsolFeed: oracleKp.publicKey,
    });
    await sendTx(connection, new Transaction().add(migIx), [admin]);
  });

  // ---------- HELPERS ----------

  /** Build an atomic_open instruction for a SOL-collateral user. */
  function buildOpen(
    user: Keypair,
    collateral: bigint,
    borrow: bigint,
    leverageBps: number,
    side: Side = Side.Long,
    spreadFeeBps?: number,
  ) {
    const atas = userAtas[user.publicKey.toBase58()];
    return buildAtomicOpenIx({
      user: user.publicKey,
      userCollateralAccount: atas.sol,
      userUsdcAccount: atas.usdc,
      collateralVault: solVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
      collateralAmount: collateral,
      borrowAmount: borrow,
      perpSide: side,
      leverageBps,
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
      spreadFeeBps,
    });
  }

  /** Close a SOL-collateral position for a user. */
  async function closePosition(user: Keypair) {
    const atas = userAtas[user.publicKey.toBase58()];
    const ix = buildAtomicCloseIx({
      user: user.publicKey,
      userCollateralAccount: atas.sol,
      userUsdcAccount: atas.usdc,
      collateralVault: solVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
    });
    await sendTx(connection, new Transaction().add(ix), [user]);
  }

  // ======================================================================
  // LEVERAGE BOUNDARY
  // ======================================================================
  //
  // Oracle: $150.  1 SOL = $150 raw, $135 after 10% haircut.
  // Param check: leverage_bps <= config.max_leverage (10000)
  // Implied check: borrow * 1000 / collateral_usd <= max_leverage

  it("accepts at exactly max leverage (10000 bps)", async () => {
    // 1 SOL, borrow 100 USDC, leverage_bps = 10000 (10x)
    // implied = 100M * 1000 / 135M = 740 (well under 10000)
    // health  = 135M * 8500 / 100M = 11475 (healthy)
    // size    = 100M * 10000 / 1000 = 1B
    const ix = buildOpen(u1, ONE_SOL, 100_000_000n, 10_000);
    await sendTx(connection, new Transaction().add(ix), [u1]);

    const posData = await connection.getAccountInfo(findPositionPda(u1.publicKey)[0]);
    expect(posData).to.not.be.null;
    const pos = decodePosition(posData!.data as Buffer);
    expect(pos.isOpen).to.equal(true);
    expect(pos.borrowAmountUsdc).to.equal(100_000_000n);

    await closePosition(u1);
  });

  it("rejects leverage_bps above max (10001)", async () => {
    // leverage_bps = 10001 > max_leverage = 10000
    const ix = buildOpen(u2, ONE_SOL, 100_000_000n, 10_001);
    await expectError(connection, new Transaction().add(ix), [u2], 6003);
  });

  it("rejects when implied leverage exceeds max", async () => {
    // leverage_bps = 10000 passes param check
    // borrow = 1_350_135_000 → implied = 1_350_135_000 * 1000 / 135_000_000 = 10001
    const ix = buildOpen(u3, ONE_SOL, 1_350_135_000n, 10_000);
    await expectError(connection, new Transaction().add(ix), [u3], 6003);
  });

  // ======================================================================
  // HEALTH FACTOR BOUNDARY
  // ======================================================================
  //
  // health = collateral_usd * liquidation_threshold / borrow_usd
  // Must be >= BPS_DENOMINATOR (10000) at open time.
  // 1 SOL after haircut = $135 (135_000_000).
  // At threshold 8500:  borrow 114_750_000 → health = 135M*8500/114.75M = 10000

  it("accepts position at health factor = exactly 10000", async () => {
    // borrow = 114_750_000 → health exactly 10000
    const ix = buildOpen(u4, ONE_SOL, 114_750_000n, 1_000);
    await sendTx(connection, new Transaction().add(ix), [u4]);

    const posData = await connection.getAccountInfo(findPositionPda(u4.publicKey)[0]);
    const pos = decodePosition(posData!.data as Buffer);
    expect(pos.isOpen).to.equal(true);

    await closePosition(u4);
  });

  it("rejects position when health factor < 10000", async () => {
    // borrow = 114_750_001 → health = floor(135M*8500/114750001) = 9999
    const ix = buildOpen(u5, ONE_SOL, 114_750_001n, 1_000);
    await expectError(connection, new Transaction().add(ix), [u5], 6005);
  });

  // ======================================================================
  // OI CAP BOUNDARY (80% of reserve)
  // ======================================================================
  //
  // Lower reserve to 5 USDC (5_000_000) → OI cap = 4_000_000.
  // position_size = borrow * leverage_bps / 1000 (at 1x: size = borrow).
  // Collateral 0.035 SOL ($5.25 raw, $4.725 after haircut) → health 10040.

  it("accepts OI at exactly 80% of reserve", async () => {
    // Lower reserve for this test
    const lowerIx = buildUpdateConfigIx({
      authority: admin.publicKey,
      totalUsdcReserve: 5_000_000n,
    });
    await sendTx(connection, new Transaction().add(lowerIx), [admin]);

    // borrow = 4M, leverage 1x → size = 4M = OI cap
    const ix = buildOpen(u6, 35_000_000n, 4_000_000n, 1_000);
    await sendTx(connection, new Transaction().add(ix), [u6]);

    const posData = await connection.getAccountInfo(findPositionPda(u6.publicKey)[0]);
    const pos = decodePosition(posData!.data as Buffer);
    expect(pos.isOpen).to.equal(true);
    expect(pos.perpSize).to.equal(4_000_000n);

    await closePosition(u6);
    // Reserve stays lowered for next test
  });

  it("rejects OI exceeding 80% of reserve", async () => {
    // Reserve still at 5M → OI cap = 4M
    // borrow = 4_000_001 → size = 4_000_001 > cap
    const ix = buildOpen(u7, 35_000_000n, 4_000_001n, 1_000);
    await expectError(connection, new Transaction().add(ix), [u7], 6008);

    // Restore reserve
    const restoreIx = buildUpdateConfigIx({
      authority: admin.publicKey,
      totalUsdcReserve: 100_000_000_000n,
    });
    await sendTx(connection, new Transaction().add(restoreIx), [admin]);
  });

  // ======================================================================
  // CORRELATED CAP (30% of total collateral)
  // ======================================================================
  //
  // JLP is "correlated" collateral. With no existing SOL collateral in the
  // system, any JLP-only position has correlated_pct = 100% > 30% cap.

  it("rejects JLP when correlated ratio exceeds 30%", async () => {
    // JLP-only position: correlated = 100% > CORRELATED_CAP_BPS (3000)
    const ix = buildAtomicOpenIx({
      user: u8.publicKey,
      userCollateralAccount: u8JlpAta,
      userUsdcAccount: u8UsdcAta,
      collateralVault: jlpVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
      collateralAmount: 10_000_000n,    // 10 JLP
      borrowAmount: 1_000_000n,         // 1 USDC
      perpSide: Side.Long,
      leverageBps: 1_000,
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
      collateralType: 1,
      jlpPrice: 200_000_000n,          // $200 (within [30, 750])
    });
    await expectError(connection, new Transaction().add(ix), [u8], 6023);
  });

  it("stress_active blocks correlated collateral (JLP)", async () => {
    // Enable stress mode
    const stressOn = buildUpdateConfigIx({
      authority: admin.publicKey,
      stressActive: true,
    });
    await sendTx(connection, new Transaction().add(stressOn), [admin]);

    // JLP open → StressActive (fires before correlated cap check)
    const ix = buildAtomicOpenIx({
      user: u9.publicKey,
      userCollateralAccount: u9JlpAta,
      userUsdcAccount: u9UsdcAta,
      collateralVault: jlpVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
      collateralAmount: 10_000_000n,
      borrowAmount: 1_000_000n,
      perpSide: Side.Long,
      leverageBps: 1_000,
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
      collateralType: 1,
      jlpPrice: 200_000_000n,
    });
    await expectError(connection, new Transaction().add(ix), [u9], 6022);

    // Restore stress
    const stressOff = buildUpdateConfigIx({
      authority: admin.publicKey,
      stressActive: false,
    });
    await sendTx(connection, new Transaction().add(stressOff), [admin]);
  });

  // ======================================================================
  // DYNAMIC SPREAD
  // ======================================================================
  //
  // Vault skew > 90% → FillsSuspended (error 6015).
  // First position always passes skew (existing OI = 0).
  // Second position sees 100% skew and is rejected.
  //
  // Min spread at 0% skew = 5 bps. spreadFeeBps < 5 → BadInput (6014).

  it("fills suspended when vault skew exceeds 90%", async () => {
    // u10 opens first long — OI was (0, 0), skew check passes
    const openIx = buildOpen(u10, ONE_SOL, 10_000_000n, 1_000);
    await sendTx(connection, new Transaction().add(openIx), [u10]);

    // u11 tries to open — OI is now (10M, 0), skew = 100% → FillsSuspended
    const failIx = buildOpen(u11, ONE_SOL, 10_000_000n, 1_000);
    await expectError(connection, new Transaction().add(failIx), [u11], 6015);

    // Cleanup: close u10 → OI back to (0, 0)
    await closePosition(u10);
  });

  it("rejects spread fee below minimum", async () => {
    // OI = (0, 0) → min_spread = 5 bps.  spreadFeeBps = 4 → BadInput
    const ix = buildOpen(u2, ONE_SOL, 10_000_000n, 1_000, Side.Long, 4);
    await expectError(connection, new Transaction().add(ix), [u2], 6014);
  });

  // ======================================================================
  // update_config COMPREHENSIVE
  // ======================================================================

  it("updates protocol_fee_bps", async () => {
    const ix = buildUpdateConfigIx({ authority: admin.publicKey, protocolFeeBps: 20 });
    await sendTx(connection, new Transaction().add(ix), [admin]);

    const cfg = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );
    expect(cfg.protocolFeeBps).to.equal(20n);

    // Restore
    const restore = buildUpdateConfigIx({ authority: admin.publicKey, protocolFeeBps: 10 });
    await sendTx(connection, new Transaction().add(restore), [admin]);
  });

  it("lower max_leverage is enforced on new opens", async () => {
    // Lower max_leverage to 5x
    const lower = buildUpdateConfigIx({ authority: admin.publicKey, maxLeverage: 5_000 });
    await sendTx(connection, new Transaction().add(lower), [admin]);

    // leverage_bps = 10000 > max_leverage = 5000 → ExcessiveLeverage
    const ix = buildOpen(u3, ONE_SOL, 100_000_000n, 10_000);
    await expectError(connection, new Transaction().add(ix), [u3], 6003);

    // Restore
    const restore = buildUpdateConfigIx({ authority: admin.publicKey, maxLeverage: 10_000 });
    await sendTx(connection, new Transaction().add(restore), [admin]);
  });

  it("updates liquidation_threshold", async () => {
    const ix = buildUpdateConfigIx({
      authority: admin.publicKey,
      liquidationThreshold: 9_000,
    });
    await sendTx(connection, new Transaction().add(ix), [admin]);

    const cfg = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );
    expect(cfg.liquidationThreshold).to.equal(9_000n);

    // Restore
    const restore = buildUpdateConfigIx({
      authority: admin.publicKey,
      liquidationThreshold: 8_500,
    });
    await sendTx(connection, new Transaction().add(restore), [admin]);
  });

  it("transfers authority to new admin", async () => {
    // Transfer admin → u12
    const transfer = buildUpdateConfigIx({
      authority: admin.publicKey,
      newAuthority: u12.publicKey,
    });
    await sendTx(connection, new Transaction().add(transfer), [admin]);

    // Old admin now rejected
    const failIx = buildUpdateConfigIx({
      authority: admin.publicKey,
      protocolFeeBps: 99,
    });
    await expectError(connection, new Transaction().add(failIx), [admin], 6010);

    // u12 transfers back
    const transferBack = buildUpdateConfigIx({
      authority: u12.publicKey,
      newAuthority: admin.publicKey,
    });
    await sendTx(connection, new Transaction().add(transferBack), [u12]);

    // Verify restored
    const cfg = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );
    expect(cfg.authority.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("rejects non-authority caller", async () => {
    const ix = buildUpdateConfigIx({
      authority: u1.publicKey,
      protocolFeeBps: 99,
    });
    await expectError(connection, new Transaction().add(ix), [u1], 6010);
  });

  // ======================================================================
  // ATOMICITY & ACCOUNT AUDIT
  // ======================================================================

  it("failed open leaves no partial state", async () => {
    const atas = userAtas[u5.publicKey.toBase58()];

    // Record balances before
    const solBefore  = (await getAccount(connection, atas.sol)).amount;
    const usdcBefore = (await getAccount(connection, atas.usdc)).amount;
    const vaultBefore = (await getAccount(connection, solVault)).amount;
    const cfgBefore = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );

    // Attempt open that fails (leverage_bps 10001 > max)
    const ix = buildOpen(u5, ONE_SOL, 100_000_000n, 10_001);
    try {
      await sendTx(connection, new Transaction().add(ix), [u5]);
      expect.fail("should have failed");
    } catch { /* expected */ }

    // All balances unchanged (Solana reverts entire transaction)
    const solAfter  = (await getAccount(connection, atas.sol)).amount;
    const usdcAfter = (await getAccount(connection, atas.usdc)).amount;
    const vaultAfter = (await getAccount(connection, solVault)).amount;
    const cfgAfter = decodeGlobalConfig(
      (await connection.getAccountInfo(configPda))!.data as Buffer,
    );

    expect(solAfter).to.equal(solBefore);
    expect(usdcAfter).to.equal(usdcBefore);
    expect(vaultAfter).to.equal(vaultBefore);
    expect(cfgAfter.totalUsdcBorrowed).to.equal(cfgBefore.totalUsdcBorrowed);

    // Position PDA never created
    const posInfo = await connection.getAccountInfo(findPositionPda(u5.publicKey)[0]);
    expect(posInfo).to.be.null;
  });

  it("atomic_open uses <= 32 accounts", () => {
    const ix = buildOpen(u1, ONE_SOL, 100_000_000n, 5_000);
    expect(ix.keys.length).to.be.at.most(32);
  });

  it("atomic_close uses <= 32 accounts", () => {
    const atas = userAtas[u1.publicKey.toBase58()];
    const ix = buildAtomicCloseIx({
      user: u1.publicKey,
      userCollateralAccount: atas.sol,
      userUsdcAccount: atas.usdc,
      collateralVault: solVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
    });
    expect(ix.keys.length).to.be.at.most(32);
  });

  it("liquidate uses <= 32 accounts", () => {
    const ix = buildLiquidateIx({
      liquidator: u1.publicKey,
      positionOwner: u2.publicKey,
      liquidatorCollateralAccount: userAtas[u1.publicKey.toBase58()].sol,
      collateralVault: solVault,
      feeRecipientCollateralAccount: userAtas[u2.publicKey.toBase58()].sol,
      pythPriceFeed: oracleKp.publicKey,
    });
    expect(ix.keys.length).to.be.at.most(32);
  });
});
