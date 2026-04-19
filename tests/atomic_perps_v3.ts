/**
 * V3 Integration Tests — Multi-collateral, stress circuit breaker, migrate_config V3.
 *
 * Build with:  anchor build --no-idl -- --features mock-oracle,dfba
 * Run with:    anchor test --skip-build
 *
 * Mock oracle returns $150 SOL/USD. For JLP, the price is passed as instruction
 * data and validated within [SOL/5, SOL*5]. For mSOL, the mock oracle also
 * reads from the feed account (which we point to SystemProgram for the default
 * $150 mock price).
 */

import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAccount, mintTo } from "@solana/spl-token";

import {
  ATOMIC_PERPS_PROGRAM_ID,
  DEFAULT_LIQUIDATION_THRESHOLD_BPS,
  DEFAULT_MAX_LEVERAGE,
  DEFAULT_MAX_TVL,
  DEFAULT_PROTOCOL_FEE_BPS,
  Side,
  SOL_DECIMALS,
  USDC_DECIMALS,
  JLP_DECIMALS,
  MSOL_DECIMALS,
} from "./helpers/ids";
import {
  buildAtomicOpenIx,
  buildAtomicCloseIx,
  buildInitializeIx,
  buildUpdateConfigIx,
  buildMigrateConfigV3Ix,
  buildLiquidateIx,
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

// === Constants ===============================================================

const RESERVE_USDC = 100_000n * 10n ** BigInt(USDC_DECIMALS);
const USER_SOL = 10n * 10n ** BigInt(SOL_DECIMALS);
const USER_JLP = 100n * 10n ** BigInt(JLP_DECIMALS);     // 100 JLP tokens
const USER_MSOL = 10n * 10n ** BigInt(MSOL_DECIMALS);     // 10 mSOL tokens

// Mock oracle always returns $150. JLP mock price: $200 (within [150/5, 150*5]).
const MOCK_JLP_PRICE_6DP = 200_000_000n;   // $200 in 6dp

async function sendTx(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  return sendAndConfirmTransaction(conn, tx, signers);
}

async function expectError(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  errorCode: number,
): Promise<void> {
  try {
    await sendTx(conn, tx, signers);
    expect.fail("Expected transaction to fail");
  } catch (e: any) {
    const msg = e.message ?? String(e);
    expect(msg).to.include(`0x${errorCode.toString(16)}`);
  }
}

describe("atomic_perps_v3 (multi-collateral)", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  const admin = Keypair.generate();
  const userSol = Keypair.generate();   // opens with SOL collateral
  const userJlp = Keypair.generate();   // opens with JLP collateral
  const userMsol = Keypair.generate();  // opens with mSOL collateral
  const liquidator = Keypair.generate();
  const feeRecipient = Keypair.generate();

  // Mints
  let solMint: PublicKey;
  let usdcMint: PublicKey;
  let jlpMint: PublicKey;
  let msolMint: PublicKey;

  // Protocol vaults
  let solVault: PublicKey;
  let usdcReserve: PublicKey;
  let jlpVault: PublicKey;
  let msolVault: PublicKey;

  // User token accounts
  let uSolSolAta: PublicKey, uSolUsdcAta: PublicKey;
  let uJlpJlpAta: PublicKey, uJlpUsdcAta: PublicKey;
  let uMsolMsolAta: PublicKey, uMsolUsdcAta: PublicKey;
  let feeUsdcAccount: PublicKey;
  let liqSolAta: PublicKey, liqJlpAta: PublicKey;
  let feeSolAta: PublicKey, feeJlpAta: PublicKey;

  const [configPda] = findConfigPda();
  const mockPythFeed = SystemProgram.programId;

  before("bootstrap validator state", async () => {
    // Airdrop SOL to all actors
    await Promise.all([
      airdrop(connection, admin.publicKey, 20),
      airdrop(connection, userSol.publicKey, 10),
      airdrop(connection, userJlp.publicKey, 10),
      airdrop(connection, userMsol.publicKey, 10),
      airdrop(connection, liquidator.publicKey, 10),
      airdrop(connection, feeRecipient.publicKey, 1),
    ]);

    // Create test mints
    solMint = await createTestMint(connection, admin, SOL_DECIMALS);
    usdcMint = await createTestMint(connection, admin, USDC_DECIMALS);
    jlpMint = await createTestMint(connection, admin, JLP_DECIMALS);
    msolMint = await createTestMint(connection, admin, MSOL_DECIMALS);

    // Protocol vaults (owned by program authority PDA)
    solVault = await createPdaOwnedTokenAccount(connection, admin, solMint);
    usdcReserve = await createPdaOwnedTokenAccount(connection, admin, usdcMint);
    jlpVault = await createPdaOwnedTokenAccount(connection, admin, jlpMint);
    msolVault = await createPdaOwnedTokenAccount(connection, admin, msolMint);

    // Fund USDC reserve
    await mintToken(connection, admin, usdcMint, usdcReserve, admin, RESERVE_USDC);

    // SOL user accounts
    uSolSolAta = await getOrCreateAta(connection, userSol, solMint, userSol.publicKey);
    uSolUsdcAta = await getOrCreateAta(connection, userSol, usdcMint, userSol.publicKey);
    await mintToken(connection, admin, solMint, uSolSolAta, admin, USER_SOL);

    // JLP user accounts
    uJlpJlpAta = await getOrCreateAta(connection, userJlp, jlpMint, userJlp.publicKey);
    uJlpUsdcAta = await getOrCreateAta(connection, userJlp, usdcMint, userJlp.publicKey);
    await mintToken(connection, admin, jlpMint, uJlpJlpAta, admin, USER_JLP);

    // mSOL user accounts
    uMsolMsolAta = await getOrCreateAta(connection, userMsol, msolMint, userMsol.publicKey);
    uMsolUsdcAta = await getOrCreateAta(connection, userMsol, usdcMint, userMsol.publicKey);
    await mintToken(connection, admin, msolMint, uMsolMsolAta, admin, USER_MSOL);

    // Fee recipient USDC account
    feeUsdcAccount = await getOrCreateAta(connection, admin, usdcMint, feeRecipient.publicKey);

    // Liquidator + fee recipient collateral ATAs (for liquidation tests)
    liqSolAta = await getOrCreateAta(connection, admin, solMint, liquidator.publicKey);
    liqJlpAta = await getOrCreateAta(connection, admin, jlpMint, liquidator.publicKey);
    feeSolAta = await getOrCreateAta(connection, admin, solMint, feeRecipient.publicKey);
    feeJlpAta = await getOrCreateAta(connection, admin, jlpMint, feeRecipient.publicKey);
  });

  // ---- Initialize ----
  it("initializes the global config", async () => {
    const ix = buildInitializeIx({
      authority: admin.publicKey,
      solVault,
      usdcReserve,
      params: {
        feeRecipient: feeRecipient.publicKey,
        pythSolFeed: mockPythFeed,
        solMint,
        usdcMint,
        maxLeverage: DEFAULT_MAX_LEVERAGE,
        liquidationThreshold: DEFAULT_LIQUIDATION_THRESHOLD_BPS,
        protocolFeeBps: DEFAULT_PROTOCOL_FEE_BPS,
        maxTvl: DEFAULT_MAX_TVL,
      },
    });
    await sendTx(connection, new Transaction().add(ix), [admin]);

    const cfg = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
    expect(cfg.authority.equals(admin.publicKey)).to.be.true;
    // V3 fields should be defaults
    expect(cfg.stressActive).to.equal(false);
    expect(cfg.totalCorrelatedCollateral).to.equal(0n);
    expect(cfg.totalCollateral).to.equal(0n);
  });

  // ---- migrate_config V3 ----
  it("migrates config to V3 with JLP/mSOL vaults", async () => {
    const ix = buildMigrateConfigV3Ix({
      authority: admin.publicKey,
      jlpMint,
      jlpVault,
      msolMint,
      msolVault,
      pythMsolFeed: mockPythFeed, // mock oracle for mSOL too
    });
    await sendTx(connection, new Transaction().add(ix), [admin]);

    const cfg = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
    expect(cfg.jlpMint.equals(jlpMint)).to.be.true;
    expect(cfg.jlpVault.equals(jlpVault)).to.be.true;
    expect(cfg.msolMint.equals(msolMint)).to.be.true;
    expect(cfg.msolVault.equals(msolVault)).to.be.true;
    expect(cfg.pythMsolFeed.equals(mockPythFeed)).to.be.true;
    expect(cfg.stressActive).to.equal(false);
  });

  it("migrate_config V3 is idempotent", async () => {
    const ix = buildMigrateConfigV3Ix({
      authority: admin.publicKey,
      jlpMint,
      jlpVault,
      msolMint,
      msolVault,
      pythMsolFeed: mockPythFeed,
    });
    await sendTx(connection, new Transaction().add(ix), [admin]);

    const cfg = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
    expect(cfg.jlpMint.equals(jlpMint)).to.be.true;
  });

  // ---- SOL collateral (regression — must still work) ----
  describe("SOL collateral (regression)", () => {
    const [posPda] = findPositionPda(userSol.publicKey);

    it("opens with SOL collateral (type=0)", async () => {
      const ix = buildAtomicOpenIx({
        user: userSol.publicKey,
        userCollateralAccount: uSolSolAta,
        userUsdcAccount: uSolUsdcAta,
        collateralVault: solVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralAmount: 1n * 10n ** 9n,    // 1 SOL
        borrowAmount: 100n * 10n ** 6n,       // 100 USDC
        perpSide: Side.Long,
        leverageBps: 5_000,
        hedgeAmount: 0n,
        jupiterSwapData: Buffer.alloc(0),
        collateralType: 0,
      });
      await sendTx(connection, new Transaction().add(ix), [userSol]);

      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.true;
      expect(pos.collateralAmount).to.equal(1n * 10n ** 9n);
      expect(pos.collateralMint.equals(solMint)).to.be.true;
      expect(pos.collateralEntryPrice).to.equal(150_000_000n); // mock $150
    });

    it("closes SOL position", async () => {
      await mintTo(connection, admin, usdcMint, uSolUsdcAta, admin, 1_000_000);
      const ix = buildAtomicCloseIx({
        user: userSol.publicKey,
        userCollateralAccount: uSolSolAta,
        userUsdcAccount: uSolUsdcAta,
        collateralVault: solVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
      });
      await sendTx(connection, new Transaction().add(ix), [userSol]);

      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.false;
    });
  });

  // ---- JLP collateral ----
  describe("JLP collateral", () => {
    const [posPda] = findPositionPda(userJlp.publicKey);

    it("opens with JLP collateral (type=1)", async () => {
      const jlpBefore = (await getAccount(connection, jlpVault)).amount;

      const ix = buildAtomicOpenIx({
        user: userJlp.publicKey,
        userCollateralAccount: uJlpJlpAta,
        userUsdcAccount: uJlpUsdcAta,
        collateralVault: jlpVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralAmount: 10n * 10n ** BigInt(JLP_DECIMALS), // 10 JLP
        borrowAmount: 50n * 10n ** 6n,                       // 50 USDC
        perpSide: Side.Long,
        leverageBps: 3_000,
        hedgeAmount: 0n,
        jupiterSwapData: Buffer.alloc(0),
        collateralType: 1,               // JLP
        jlpPrice: MOCK_JLP_PRICE_6DP,    // $200
      });
      await sendTx(connection, new Transaction().add(ix), [userJlp]);

      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.true;
      expect(pos.collateralMint.equals(jlpMint)).to.be.true;
      expect(pos.collateralEntryPrice).to.equal(MOCK_JLP_PRICE_6DP);

      // JLP transferred to vault
      const jlpAfter = (await getAccount(connection, jlpVault)).amount;
      expect(jlpAfter - jlpBefore).to.equal(10n * 10n ** BigInt(JLP_DECIMALS));

      // Config tracks correlated collateral
      const cfg = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      expect(cfg.totalCorrelatedCollateral > 0n).to.be.true;
      expect(cfg.totalCollateral > 0n).to.be.true;
    });

    it("closes JLP position — returns from JLP vault", async () => {
      await mintTo(connection, admin, usdcMint, uJlpUsdcAta, admin, 100_000_000);

      const jlpBefore = (await getAccount(connection, uJlpJlpAta)).amount;
      const ix = buildAtomicCloseIx({
        user: userJlp.publicKey,
        userCollateralAccount: uJlpJlpAta,
        userUsdcAccount: uJlpUsdcAta,
        collateralVault: jlpVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralPrice: MOCK_JLP_PRICE_6DP,
      });
      await sendTx(connection, new Transaction().add(ix), [userJlp]);

      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.false;

      // User got JLP back
      const jlpAfter = (await getAccount(connection, uJlpJlpAta)).amount;
      expect(jlpAfter > jlpBefore).to.be.true;
    });
  });

  // ---- mSOL collateral ----
  describe("mSOL collateral", () => {
    const [posPda] = findPositionPda(userMsol.publicKey);

    it("opens with mSOL collateral (type=2)", async () => {
      const msolBefore = (await getAccount(connection, msolVault)).amount;

      const ix = buildAtomicOpenIx({
        user: userMsol.publicKey,
        userCollateralAccount: uMsolMsolAta,
        userUsdcAccount: uMsolUsdcAta,
        collateralVault: msolVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralAmount: 1n * 10n ** BigInt(MSOL_DECIMALS), // 1 mSOL
        borrowAmount: 50n * 10n ** 6n,                       // 50 USDC
        perpSide: Side.Long,
        leverageBps: 3_000,
        hedgeAmount: 0n,
        jupiterSwapData: Buffer.alloc(0),
        collateralType: 2,               // mSOL
        msolFeedAccount: mockPythFeed,   // mock oracle for mSOL
      });
      await sendTx(connection, new Transaction().add(ix), [userMsol]);

      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.true;
      expect(pos.collateralMint.equals(msolMint)).to.be.true;

      // mSOL transferred to vault
      const msolAfter = (await getAccount(connection, msolVault)).amount;
      expect(msolAfter - msolBefore).to.equal(1n * 10n ** BigInt(MSOL_DECIMALS));
    });

    it("closes mSOL position", async () => {
      await mintTo(connection, admin, usdcMint, uMsolUsdcAta, admin, 100_000_000);

      const ix = buildAtomicCloseIx({
        user: userMsol.publicKey,
        userCollateralAccount: uMsolMsolAta,
        userUsdcAccount: uMsolUsdcAta,
        collateralVault: msolVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        msolFeedAccount: mockPythFeed,
      });
      await sendTx(connection, new Transaction().add(ix), [userMsol]);

      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.false;
    });
  });

  // ---- Stress circuit breaker ----
  describe("stress_active flag", () => {
    it("update_config sets stress_active = true", async () => {
      const ix = buildUpdateConfigIx({
        authority: admin.publicKey,
        stressActive: true,
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);

      const cfg = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      expect(cfg.stressActive).to.equal(true);
    });

    it("rejects JLP open when stress_active (6022 StressActive)", async () => {
      // userSol's position is closed, re-use them for a fresh JLP open attempt
      // Actually use a fresh user to avoid PDA-already-exists
      const freshUser = Keypair.generate();
      await airdrop(connection, freshUser.publicKey, 5);
      const freshJlp = await getOrCreateAta(connection, freshUser, jlpMint, freshUser.publicKey);
      const freshUsdc = await getOrCreateAta(connection, freshUser, usdcMint, freshUser.publicKey);
      await mintToken(connection, admin, jlpMint, freshJlp, admin, 10n * 10n ** BigInt(JLP_DECIMALS));

      const ix = buildAtomicOpenIx({
        user: freshUser.publicKey,
        userCollateralAccount: freshJlp,
        userUsdcAccount: freshUsdc,
        collateralVault: jlpVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralAmount: 5n * 10n ** BigInt(JLP_DECIMALS),
        borrowAmount: 50n * 10n ** 6n,
        perpSide: Side.Long,
        leverageBps: 3_000,
        hedgeAmount: 0n,
        jupiterSwapData: Buffer.alloc(0),
        collateralType: 1,
        jlpPrice: MOCK_JLP_PRICE_6DP,
      });
      await expectError(connection, new Transaction().add(ix), [freshUser], 6022);
    });

    it("rejects mSOL open when stress_active (6022 StressActive)", async () => {
      const freshUser = Keypair.generate();
      await airdrop(connection, freshUser.publicKey, 5);
      const freshMsol = await getOrCreateAta(connection, freshUser, msolMint, freshUser.publicKey);
      const freshUsdc = await getOrCreateAta(connection, freshUser, usdcMint, freshUser.publicKey);
      await mintToken(connection, admin, msolMint, freshMsol, admin, 1n * 10n ** BigInt(MSOL_DECIMALS));

      const ix = buildAtomicOpenIx({
        user: freshUser.publicKey,
        userCollateralAccount: freshMsol,
        userUsdcAccount: freshUsdc,
        collateralVault: msolVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralAmount: 1n * 10n ** BigInt(MSOL_DECIMALS),
        borrowAmount: 50n * 10n ** 6n,
        perpSide: Side.Long,
        leverageBps: 3_000,
        hedgeAmount: 0n,
        jupiterSwapData: Buffer.alloc(0),
        collateralType: 2,
        msolFeedAccount: mockPythFeed,
      });
      await expectError(connection, new Transaction().add(ix), [freshUser], 6022);
    });

    it("SOL opens still work during stress", async () => {
      // SOL is uncorrelated — should NOT be blocked by stress
      const freshUser = Keypair.generate();
      await airdrop(connection, freshUser.publicKey, 5);
      const freshSol = await getOrCreateAta(connection, freshUser, solMint, freshUser.publicKey);
      const freshUsdc = await getOrCreateAta(connection, freshUser, usdcMint, freshUser.publicKey);
      await mintToken(connection, admin, solMint, freshSol, admin, 2n * 10n ** 9n);

      const ix = buildAtomicOpenIx({
        user: freshUser.publicKey,
        userCollateralAccount: freshSol,
        userUsdcAccount: freshUsdc,
        collateralVault: solVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralAmount: 1n * 10n ** 9n,
        borrowAmount: 50n * 10n ** 6n,
        perpSide: Side.Long,
        leverageBps: 3_000,
        hedgeAmount: 0n,
        jupiterSwapData: Buffer.alloc(0),
        collateralType: 0,
      });
      await sendTx(connection, new Transaction().add(ix), [freshUser]);

      const [posPda] = findPositionPda(freshUser.publicKey);
      const pos = decodePosition((await connection.getAccountInfo(posPda))!.data);
      expect(pos.isOpen).to.be.true;
    });

    it("update_config resets stress_active = false", async () => {
      const ix = buildUpdateConfigIx({
        authority: admin.publicKey,
        stressActive: false,
      });
      await sendTx(connection, new Transaction().add(ix), [admin]);

      const cfg = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
      expect(cfg.stressActive).to.equal(false);
    });
  });

  // ---- JLP price validation ----
  describe("JLP price sanity", () => {
    it("rejects JLP open with out-of-range price (6024 JlpPriceOutOfRange)", async () => {
      const freshUser = Keypair.generate();
      await airdrop(connection, freshUser.publicKey, 5);
      const freshJlp = await getOrCreateAta(connection, freshUser, jlpMint, freshUser.publicKey);
      const freshUsdc = await getOrCreateAta(connection, freshUser, usdcMint, freshUser.publicKey);
      await mintToken(connection, admin, jlpMint, freshJlp, admin, 10n * 10n ** BigInt(JLP_DECIMALS));

      // JLP price = $1000, SOL = $150 → 1000/150 > 5x → rejected
      const ix = buildAtomicOpenIx({
        user: freshUser.publicKey,
        userCollateralAccount: freshJlp,
        userUsdcAccount: freshUsdc,
        collateralVault: jlpVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralAmount: 5n * 10n ** BigInt(JLP_DECIMALS),
        borrowAmount: 50n * 10n ** 6n,
        perpSide: Side.Long,
        leverageBps: 3_000,
        hedgeAmount: 0n,
        jupiterSwapData: Buffer.alloc(0),
        collateralType: 1,
        jlpPrice: 1_000_000_000n,  // $1000 — out of range
      });
      await expectError(connection, new Transaction().add(ix), [freshUser], 6024);
    });
  });

  // ---- Liquidation with healthy JLP position ----
  describe("JLP liquidation guard", () => {
    it("rejects liquidation of healthy JLP position (6006 NotLiquidatable)", async () => {
      // Open a well-collateralized JLP position first
      const freshUser = Keypair.generate();
      await airdrop(connection, freshUser.publicKey, 5);
      const freshJlp = await getOrCreateAta(connection, freshUser, jlpMint, freshUser.publicKey);
      const freshUsdc = await getOrCreateAta(connection, freshUser, usdcMint, freshUser.publicKey);
      await mintToken(connection, admin, jlpMint, freshJlp, admin, 50n * 10n ** BigInt(JLP_DECIMALS));

      const openIx = buildAtomicOpenIx({
        user: freshUser.publicKey,
        userCollateralAccount: freshJlp,
        userUsdcAccount: freshUsdc,
        collateralVault: jlpVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralAmount: 20n * 10n ** BigInt(JLP_DECIMALS),
        borrowAmount: 50n * 10n ** 6n,
        perpSide: Side.Long,
        leverageBps: 2_000,
        hedgeAmount: 0n,
        jupiterSwapData: Buffer.alloc(0),
        collateralType: 1,
        jlpPrice: MOCK_JLP_PRICE_6DP,
      });
      await sendTx(connection, new Transaction().add(openIx), [freshUser]);

      // Try to liquidate — should fail (position is healthy)
      const liqIx = buildLiquidateIx({
        liquidator: liquidator.publicKey,
        positionOwner: freshUser.publicKey,
        liquidatorCollateralAccount: liqJlpAta,
        collateralVault: jlpVault,
        feeRecipientCollateralAccount: feeJlpAta,
        pythPriceFeed: mockPythFeed,
        collateralPrice: MOCK_JLP_PRICE_6DP,
      });
      await expectError(connection, new Transaction().add(liqIx), [liquidator], 6006);

      // Clean up: close
      await mintTo(connection, admin, usdcMint, freshUsdc, admin, 100_000_000);
      const closeIx = buildAtomicCloseIx({
        user: freshUser.publicKey,
        userCollateralAccount: freshJlp,
        userUsdcAccount: freshUsdc,
        collateralVault: jlpVault,
        usdcReserve,
        feeRecipientAccount: feeUsdcAccount,
        pythPriceFeed: mockPythFeed,
        collateralPrice: MOCK_JLP_PRICE_6DP,
      });
      await sendTx(connection, new Transaction().add(closeIx), [freshUser]);
    });
  });
});
