/**
 * Liquidation & PnL settlement tests.
 *
 * Uses the set_mock_oracle instruction for variable-price oracle accounts,
 * and set_test_config to seed OI/collateral state for JLP tests.
 * Each position uses a unique user to avoid PDA reuse issues
 * (create_pda_account fails on existing PDAs).
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
import { getAccount, mintTo } from "@solana/spl-token";

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
  buildSetTestConfigIx,
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
  updateOraclePrice,
} from "./helpers/oracle";

// Amounts
const RESERVE_USDC = 100_000n * 10n ** BigInt(USDC_DECIMALS);
const ONE_SOL = 1n * 10n ** BigInt(SOL_DECIMALS);
const USER_JLP = 100n * 10n ** BigInt(JLP_DECIMALS);

async function sendTx(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  return sendAndConfirmTransaction(conn, tx, signers);
}

async function expectError(conn: Connection, tx: Transaction, signers: Keypair[], errorCode: number): Promise<void> {
  try {
    await sendTx(conn, tx, signers);
    expect.fail("Expected transaction to fail");
  } catch (e: any) {
    const msg = e.message ?? String(e);
    expect(msg).to.include(`0x${errorCode.toString(16)}`);
  }
}

describe("liquidation_pnl", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  const admin = Keypair.generate();
  // Each position uses a unique user — create_pda_account fails on existing PDAs
  const user1 = Keypair.generate();   // PnL long positive
  const user2 = Keypair.generate();   // PnL long negative
  const user3 = Keypair.generate();   // PnL short positive
  const user4 = Keypair.generate();   // PnL short negative
  const user5 = Keypair.generate();   // Liq unhealthy long
  const user6 = Keypair.generate();   // Liq unhealthy short
  const user7 = Keypair.generate();   // Liq healthy rejection
  const user8 = Keypair.generate();   // Liq bonus exact
  const user9 = Keypair.generate();   // JLP grace period
  const user10 = Keypair.generate();  // JLP entry_price
  const user11 = Keypair.generate();  // Fee open + close
  const user12 = Keypair.generate();  // OI long decrement
  const user13 = Keypair.generate();  // OI short decrement
  const liquidator = Keypair.generate();
  const feeRecipient = Keypair.generate();

  let solMint: PublicKey, usdcMint: PublicKey, jlpMint: PublicKey, msolMint: PublicKey;
  let solVault: PublicKey, usdcReserve: PublicKey, jlpVault: PublicKey, msolVault: PublicKey;
  let feeUsdcAccount: PublicKey;
  let oracleKp: Keypair;

  const [configPda] = findConfigPda();

  // Per-user ATAs
  const solAtas: Record<string, PublicKey> = {};
  const usdcAtas: Record<string, PublicKey> = {};
  const jlpAtas: Record<string, PublicKey> = {};

  let liqSolAta: PublicKey, feeSolAta: PublicKey;
  let liqJlpAta: PublicKey, feeJlpAta: PublicKey;

  before("bootstrap validator state with variable oracle", async () => {
    const solUsers = [user1, user2, user3, user4, user5, user6, user7, user8, user11, user12, user13];
    const jlpUsers = [user9, user10];
    const allActors = [admin, ...solUsers, ...jlpUsers, liquidator, feeRecipient];
    await Promise.all(allActors.map((a) => airdrop(connection, a.publicKey, 20)));

    solMint = await createTestMint(connection, admin, SOL_DECIMALS);
    usdcMint = await createTestMint(connection, admin, USDC_DECIMALS);
    jlpMint = await createTestMint(connection, admin, JLP_DECIMALS);
    msolMint = await createTestMint(connection, admin, SOL_DECIMALS);

    solVault = await createPdaOwnedTokenAccount(connection, admin, solMint);
    usdcReserve = await createPdaOwnedTokenAccount(connection, admin, usdcMint);
    jlpVault = await createPdaOwnedTokenAccount(connection, admin, jlpMint);
    msolVault = await createPdaOwnedTokenAccount(connection, admin, msolMint);

    await mintToken(connection, admin, usdcMint, usdcReserve, admin, RESERVE_USDC);
    // Seed SOL vault so there's collateral to pay out PnL
    await mintToken(connection, admin, solMint, solVault, admin, 100n * ONE_SOL);

    // Create variable oracle at $150
    oracleKp = await createMockOracleAccount(connection, admin, 150_000_000n, 10_000n);

    // SOL user ATAs
    for (const u of solUsers) {
      const key = u.publicKey.toBase58();
      solAtas[key] = await getOrCreateAta(connection, u, solMint, u.publicKey);
      usdcAtas[key] = await getOrCreateAta(connection, u, usdcMint, u.publicKey);
      await mintToken(connection, admin, solMint, solAtas[key], admin, 10n * ONE_SOL);
    }

    // JLP user ATAs
    for (const u of jlpUsers) {
      const key = u.publicKey.toBase58();
      jlpAtas[key] = await getOrCreateAta(connection, u, jlpMint, u.publicKey);
      usdcAtas[key] = await getOrCreateAta(connection, u, usdcMint, u.publicKey);
      await mintToken(connection, admin, jlpMint, jlpAtas[key], admin, USER_JLP);
    }

    feeUsdcAccount = await getOrCreateAta(connection, admin, usdcMint, feeRecipient.publicKey);
    liqSolAta = await getOrCreateAta(connection, admin, solMint, liquidator.publicKey);
    feeSolAta = await getOrCreateAta(connection, admin, solMint, feeRecipient.publicKey);
    liqJlpAta = await getOrCreateAta(connection, admin, jlpMint, liquidator.publicKey);
    feeJlpAta = await getOrCreateAta(connection, admin, jlpMint, feeRecipient.publicKey);

    // Initialize protocol with variable oracle
    const ix = buildInitializeIx({
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
    await sendTx(connection, new Transaction().add(ix), [admin]);

    // Migrate to V3
    const mig = buildMigrateConfigV3Ix({
      authority: admin.publicKey,
      jlpMint,
      jlpVault,
      msolMint,
      msolVault,
      pythMsolFeed: oracleKp.publicKey,
    });
    await sendTx(connection, new Transaction().add(mig), [admin]);
  });

  // Helper: open a SOL-collateral position
  async function openSolPosition(
    user: Keypair,
    collateralAmount: bigint,
    borrowAmount: bigint,
    side: number,
    leverageBps = 5_000,
  ) {
    const key = user.publicKey.toBase58();
    const ix = buildAtomicOpenIx({
      user: user.publicKey,
      userCollateralAccount: solAtas[key],
      userUsdcAccount: usdcAtas[key],
      collateralVault: solVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
      collateralAmount,
      borrowAmount,
      perpSide: side,
      leverageBps,
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
    });
    await sendTx(connection, new Transaction().add(ix), [user]);
  }

  // Helper: open a JLP-collateral position
  async function openJlpPosition(
    user: Keypair,
    collateralAmount: bigint,
    borrowAmount: bigint,
    side: number,
    jlpPrice: bigint,
    leverageBps = 5_000,
  ) {
    const key = user.publicKey.toBase58();
    const ix = buildAtomicOpenIx({
      user: user.publicKey,
      userCollateralAccount: jlpAtas[key],
      userUsdcAccount: usdcAtas[key],
      collateralVault: jlpVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
      collateralAmount,
      borrowAmount,
      perpSide: side,
      leverageBps,
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
      collateralType: 1,
      jlpPrice,
    });
    await sendTx(connection, new Transaction().add(ix), [user]);
  }

  // Helper: close a SOL-collateral position (mints USDC for repayment)
  async function closeSolPosition(user: Keypair) {
    const key = user.publicKey.toBase58();
    await mintTo(connection, admin, usdcMint, usdcAtas[key], admin, 200_000_000);
    const ix = buildAtomicCloseIx({
      user: user.publicKey,
      userCollateralAccount: solAtas[key],
      userUsdcAccount: usdcAtas[key],
      collateralVault: solVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
    });
    await sendTx(connection, new Transaction().add(ix), [user]);
  }

  // Helper: close a JLP-collateral position (mints USDC for repayment)
  async function closeJlpPosition(user: Keypair, jlpPrice: bigint) {
    const key = user.publicKey.toBase58();
    await mintTo(connection, admin, usdcMint, usdcAtas[key], admin, 200_000_000);
    const ix = buildAtomicCloseIx({
      user: user.publicKey,
      userCollateralAccount: jlpAtas[key],
      userUsdcAccount: usdcAtas[key],
      collateralVault: jlpVault,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracleKp.publicKey,
      collateralPrice: jlpPrice,
    });
    await sendTx(connection, new Transaction().add(ix), [user]);
  }

  // Reset OI before each test to prevent FillsSuspended from vault skew
  beforeEach(async () => {
    const resetIx = buildSetTestConfigIx({
      authority: admin.publicKey,
      totalLongOi: 0n,
      totalShortOi: 0n,
    });
    await sendTx(connection, new Transaction().add(resetIx), [admin]);
  });

  // ===== PnL Settlement Tests =====

  describe("PnL settlement — long positions", () => {
    it("closes long with positive PnL (price rises $150->$180)", async () => {
      await openSolPosition(user1, ONE_SOL, 100_000_000n, Side.Long);

      const key = user1.publicKey.toBase58();
      const userSolBefore = (await getAccount(connection, solAtas[key])).amount;

      // Update oracle to $180 (+20%)
      await updateOraclePrice(connection, admin, oracleKp, 180_000_000n, 10_000n);

      // Mint USDC for repayment
      await mintTo(connection, admin, usdcMint, usdcAtas[key], admin, 200_000_000);

      const ix = buildAtomicCloseIx({
        user: user1.publicKey,
        userCollateralAccount: solAtas[key],
        userUsdcAccount: usdcAtas[key],
        collateralVault: solVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: oracleKp.publicKey,
      });
      await sendTx(connection, new Transaction().add(ix), [user1]);

      const [posPda] = findPositionPda(user1.publicKey);
      const posInfo = await connection.getAccountInfo(posPda);
      const pos = decodePosition(posInfo!.data as Buffer);
      expect(pos.isOpen).to.be.false;

      const userSolAfter = (await getAccount(connection, solAtas[key])).amount;
      // With positive PnL, user gets back MORE than 1 SOL
      expect(userSolAfter > userSolBefore).to.be.true;

      await updateOraclePrice(connection, admin, oracleKp, 150_000_000n, 10_000n);
    });

    it("closes long with negative PnL (price drops $150->$120)", async () => {
      await openSolPosition(user2, ONE_SOL, 100_000_000n, Side.Long);

      const key = user2.publicKey.toBase58();
      const userSolBefore = (await getAccount(connection, solAtas[key])).amount;

      // Drop price to $120
      await updateOraclePrice(connection, admin, oracleKp, 120_000_000n, 10_000n);
      await mintTo(connection, admin, usdcMint, usdcAtas[key], admin, 200_000_000);

      const ix = buildAtomicCloseIx({
        user: user2.publicKey,
        userCollateralAccount: solAtas[key],
        userUsdcAccount: usdcAtas[key],
        collateralVault: solVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: oracleKp.publicKey,
      });
      await sendTx(connection, new Transaction().add(ix), [user2]);

      const [posPda] = findPositionPda(user2.publicKey);
      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.false;

      const userSolAfter = (await getAccount(connection, solAtas[key])).amount;
      const returned = userSolAfter - userSolBefore;
      // With negative PnL, user gets back LESS than deposited 1 SOL
      expect(returned < ONE_SOL).to.be.true;

      await updateOraclePrice(connection, admin, oracleKp, 150_000_000n, 10_000n);
    });
  });

  describe("PnL settlement — short positions", () => {
    it("closes short with positive PnL (price drops $150->$120)", async () => {
      await openSolPosition(user3, ONE_SOL, 100_000_000n, Side.Short);

      const key = user3.publicKey.toBase58();
      const userSolBefore = (await getAccount(connection, solAtas[key])).amount;

      await updateOraclePrice(connection, admin, oracleKp, 120_000_000n, 10_000n);
      await mintTo(connection, admin, usdcMint, usdcAtas[key], admin, 200_000_000);

      const ix = buildAtomicCloseIx({
        user: user3.publicKey,
        userCollateralAccount: solAtas[key],
        userUsdcAccount: usdcAtas[key],
        collateralVault: solVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: oracleKp.publicKey,
      });
      await sendTx(connection, new Transaction().add(ix), [user3]);

      const [posPda] = findPositionPda(user3.publicKey);
      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.false;

      const userSolAfter = (await getAccount(connection, solAtas[key])).amount;
      const returned = userSolAfter - userSolBefore;
      // Short profits from price drop → gets more than 1 SOL
      expect(returned > ONE_SOL).to.be.true;

      await updateOraclePrice(connection, admin, oracleKp, 150_000_000n, 10_000n);
    });

    it("closes short with negative PnL (price rises $150->$180)", async () => {
      await openSolPosition(user4, ONE_SOL, 100_000_000n, Side.Short);

      const key = user4.publicKey.toBase58();
      const userSolBefore = (await getAccount(connection, solAtas[key])).amount;

      await updateOraclePrice(connection, admin, oracleKp, 180_000_000n, 10_000n);
      await mintTo(connection, admin, usdcMint, usdcAtas[key], admin, 200_000_000);

      const ix = buildAtomicCloseIx({
        user: user4.publicKey,
        userCollateralAccount: solAtas[key],
        userUsdcAccount: usdcAtas[key],
        collateralVault: solVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: oracleKp.publicKey,
      });
      await sendTx(connection, new Transaction().add(ix), [user4]);

      const [posPda] = findPositionPda(user4.publicKey);
      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.false;

      const userSolAfter = (await getAccount(connection, solAtas[key])).amount;
      const returned = userSolAfter - userSolBefore;
      // Short loses → less than 1 SOL returned
      expect(returned < ONE_SOL).to.be.true;

      await updateOraclePrice(connection, admin, oracleKp, 150_000_000n, 10_000n);
    });
  });

  // ===== Liquidation Tests =====

  describe("Liquidation — SOL collateral", () => {
    it("liquidates unhealthy long when price drops ($150->$80)", async () => {
      await openSolPosition(user5, ONE_SOL, 100_000_000n, Side.Long);

      const [posPda] = findPositionPda(user5.publicKey);
      const posBefore = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(posBefore.isOpen).to.be.true;

      const cfgBefore = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);

      // Drop price to $80 — position becomes unhealthy
      // Health = (1 SOL * $80 * 0.9 haircut * 8500 threshold) / $100 borrow = 6120 < 10000
      await updateOraclePrice(connection, admin, oracleKp, 80_000_000n, 10_000n);

      const liqBefore = (await getAccount(connection, liqSolAta)).amount;

      const ix = buildLiquidateIx({
        liquidator: liquidator.publicKey,
        positionOwner: user5.publicKey,
        liquidatorCollateralAccount: liqSolAta,
        collateralVault: solVault,
        feeRecipientCollateralAccount: feeSolAta,
        pythPriceFeed: oracleKp.publicKey,
      });
      await sendTx(connection, new Transaction().add(ix), [liquidator]);

      const posAfter = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(posAfter.isOpen).to.be.false;

      // Liquidator received 5% bonus
      const liqAfter = (await getAccount(connection, liqSolAta)).amount;
      const bonus = liqAfter - liqBefore;
      const expectedBonus = ONE_SOL * 500n / 10_000n;  // 5% of 1 SOL
      expect(bonus).to.equal(expectedBonus);

      // Global OI decremented
      const cfgAfter = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      expect(cfgAfter.totalLongOi < cfgBefore.totalLongOi).to.be.true;

      await updateOraclePrice(connection, admin, oracleKp, 150_000_000n, 10_000n);
    });

    it("liquidates unhealthy short when collateral drops ($150->$80)", async () => {
      await openSolPosition(user6, ONE_SOL, 100_000_000n, Side.Short);

      const cfgBefore = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);

      // Drop price to $80 — SOL collateral (1 SOL @ $80 = $80) falls below
      // borrow threshold: health = $80*0.9*8500/$100 = 6120 < 10000
      // (Short perp profits from price drop, but collateral health fails)
      await updateOraclePrice(connection, admin, oracleKp, 80_000_000n, 10_000n);

      const ix = buildLiquidateIx({
        liquidator: liquidator.publicKey,
        positionOwner: user6.publicKey,
        liquidatorCollateralAccount: liqSolAta,
        collateralVault: solVault,
        feeRecipientCollateralAccount: feeSolAta,
        pythPriceFeed: oracleKp.publicKey,
      });
      await sendTx(connection, new Transaction().add(ix), [liquidator]);

      const [posPda] = findPositionPda(user6.publicKey);
      const posAfter = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(posAfter.isOpen).to.be.false;

      const cfgAfter = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      expect(cfgAfter.totalShortOi < cfgBefore.totalShortOi).to.be.true;

      await updateOraclePrice(connection, admin, oracleKp, 150_000_000n, 10_000n);
    });

    it("rejects liquidation of slightly-dipped but healthy position", async () => {
      // Open: 2 SOL ($300), borrow only 50 USDC — very healthy
      await openSolPosition(user7, 2n * ONE_SOL, 50_000_000n, Side.Long);

      // Drop to $140 — still healthy
      // Health = (2 * $140 * 0.9 * 8500) / $50 = 42840 >> 10000
      await updateOraclePrice(connection, admin, oracleKp, 140_000_000n, 10_000n);

      const ix = buildLiquidateIx({
        liquidator: liquidator.publicKey,
        positionOwner: user7.publicKey,
        liquidatorCollateralAccount: liqSolAta,
        collateralVault: solVault,
        feeRecipientCollateralAccount: feeSolAta,
        pythPriceFeed: oracleKp.publicKey,
      });
      // Error 6006 = PositionHealthy
      await expectError(connection, new Transaction().add(ix), [liquidator], 6006);

      // Clean up: close the healthy position
      await updateOraclePrice(connection, admin, oracleKp, 150_000_000n, 10_000n);
      await closeSolPosition(user7);
    });

    it("liquidation bonus + fee split is exact", async () => {
      await openSolPosition(user8, ONE_SOL, 100_000_000n, Side.Long);

      await updateOraclePrice(connection, admin, oracleKp, 80_000_000n, 10_000n);

      const liqBefore = (await getAccount(connection, liqSolAta)).amount;
      const feeBefore = (await getAccount(connection, feeSolAta)).amount;

      const ix = buildLiquidateIx({
        liquidator: liquidator.publicKey,
        positionOwner: user8.publicKey,
        liquidatorCollateralAccount: liqSolAta,
        collateralVault: solVault,
        feeRecipientCollateralAccount: feeSolAta,
        pythPriceFeed: oracleKp.publicKey,
      });
      await sendTx(connection, new Transaction().add(ix), [liquidator]);

      const liqAfter = (await getAccount(connection, liqSolAta)).amount;
      const feeAfter = (await getAccount(connection, feeSolAta)).amount;

      const bonus = liqAfter - liqBefore;
      const remainder = feeAfter - feeBefore;

      // Total = bonus + remainder = 1 SOL (collateral_amount)
      expect(bonus + remainder).to.equal(ONE_SOL);
      // Bonus = 5% of 1 SOL
      expect(bonus).to.equal(ONE_SOL * 500n / 10_000n);
      // Remainder = 95%
      expect(remainder).to.equal(ONE_SOL - bonus);

      await updateOraclePrice(connection, admin, oracleKp, 150_000_000n, 10_000n);
    });
  });

  // ===== JLP Liquidation Guards =====

  describe("Liquidation — JLP collateral", () => {
    // Seed balanced OI + total_collateral so JLP opens pass the correlated cap (30%)
    // and vault skew checks. Without this, JLP-only = 100% correlated > 30%.
    before("seed balanced OI + collateral for JLP tests", async () => {
      const ix = buildSetTestConfigIx({
        authority: admin.publicKey,
        totalLongOi: 500_000_000n,
        totalShortOi: 500_000_000n,
        totalCollateral: 10_000_000_000n,
        totalCorrelatedCollateral: 0n,
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
    });

    after("reset OI + collateral after JLP tests", async () => {
      const ix = buildSetTestConfigIx({
        authority: admin.publicKey,
        totalLongOi: 0n,
        totalShortOi: 0n,
        totalCollateral: 0n,
        totalCorrelatedCollateral: 0n,
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);
    });

    it("rejects JLP liquidation within grace period (<7200s)", async () => {
      await openJlpPosition(user9, 10n * 10n ** BigInt(JLP_DECIMALS), 100_000_000n, Side.Long, 200_000_000n);

      // Even if unhealthy, grace period blocks liquidation
      // Grace period check comes BEFORE health check in liquidate.rs
      const ix = buildLiquidateIx({
        liquidator: liquidator.publicKey,
        positionOwner: user9.publicKey,
        liquidatorCollateralAccount: liqJlpAta,
        collateralVault: jlpVault,
        feeRecipientCollateralAccount: feeJlpAta,
        pythPriceFeed: oracleKp.publicKey,
        collateralPrice: 200_000_000n,
      });
      // Error 6025 = LiquidationGracePeriod
      await expectError(connection, new Transaction().add(ix), [liquidator], 6025);

      await closeJlpPosition(user9, 200_000_000n);
    });

    it("JLP health uses max(entry_price, current_price) — stores entry price", async () => {
      await openJlpPosition(user10, 10n * 10n ** BigInt(JLP_DECIMALS), 100_000_000n, Side.Long, 200_000_000n);

      const [posPda] = findPositionPda(user10.publicKey);
      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.collateralEntryPrice).to.equal(200_000_000n);
      expect(pos.isOpen).to.be.true;

      await closeJlpPosition(user10, 200_000_000n);
    });
  });

  // ===== Fee Verification =====

  describe("Fee verification", () => {
    it("open fee splits 10% PSF / 90% recipient", async () => {
      const cfgBefore = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      const feeUsdcBefore = (await getAccount(connection, feeUsdcAccount)).amount;

      const borrowAmount = 100_000_000n; // 100 USDC
      await openSolPosition(user11, ONE_SOL, borrowAmount, Side.Long);

      const cfgAfter = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);

      // Total fee = borrow * (protocol_fee + spread_fee) / 10000
      // protocol_fee = 10 bps, spread_fee = 5 bps (minimum at 0% skew), total = 15 bps
      const totalFee = borrowAmount * 15n / 10_000n;
      const expectedPsf = totalFee / 10n;

      const psfDelta = cfgAfter.psfBalance - cfgBefore.psfBalance;
      expect(psfDelta).to.equal(expectedPsf);

      const feeUsdcAfter = (await getAccount(connection, feeUsdcAccount)).amount;
      const recipientDelta = feeUsdcAfter - feeUsdcBefore;
      expect(recipientDelta).to.equal(totalFee - expectedPsf);
    });

    it("close fee splits 10% PSF / 90% recipient", async () => {
      const [posPda] = findPositionPda(user11.publicKey);
      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      const borrowAmount = pos.borrowAmountUsdc;

      const cfgBefore = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      const feeUsdcBefore = (await getAccount(connection, feeUsdcAccount)).amount;

      const key = user11.publicKey.toBase58();
      await mintTo(connection, admin, usdcMint, usdcAtas[key], admin, 200_000_000);

      const ix = buildAtomicCloseIx({
        user: user11.publicKey,
        userCollateralAccount: solAtas[key],
        userUsdcAccount: usdcAtas[key],
        collateralVault: solVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: oracleKp.publicKey,
      });
      await sendTx(connection, new Transaction().add(ix), [user11]);

      const cfgAfter = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);

      // Close fee = borrow * protocol_fee_bps / 10000 (no spread on close)
      const closeFee = borrowAmount * BigInt(DEFAULT_PROTOCOL_FEE_BPS) / 10_000n;
      const expectedPsf = closeFee / 10n;

      const psfDelta = cfgAfter.psfBalance - cfgBefore.psfBalance;
      expect(psfDelta).to.equal(expectedPsf);

      const feeUsdcAfter = (await getAccount(connection, feeUsdcAccount)).amount;
      const recipientDelta = feeUsdcAfter - feeUsdcBefore;
      expect(recipientDelta).to.equal(closeFee - expectedPsf);
    });
  });

  // ===== OI Tracking on Close =====

  describe("OI tracking on close", () => {
    it("close decrements total_long_oi by perp_size", async () => {
      await openSolPosition(user12, ONE_SOL, 100_000_000n, Side.Long);

      const [posPda] = findPositionPda(user12.publicKey);
      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      const perpSize = pos.perpSize;

      const cfgBefore = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);

      await closeSolPosition(user12);

      const cfgAfter = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      expect(cfgBefore.totalLongOi - cfgAfter.totalLongOi).to.equal(perpSize);
    });

    it("close decrements total_short_oi by perp_size", async () => {
      await openSolPosition(user13, ONE_SOL, 100_000_000n, Side.Short);

      const [posPda] = findPositionPda(user13.publicKey);
      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      const perpSize = pos.perpSize;

      const cfgBefore = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);

      await closeSolPosition(user13);

      const cfgAfter = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      expect(cfgBefore.totalShortOi - cfgAfter.totalShortOi).to.equal(perpSize);
    });
  });
});
