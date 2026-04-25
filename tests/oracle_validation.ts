/**
 * Oracle validation tests.
 *
 * Tests the mock oracle's behavior: custom prices, price updates,
 * zero-price fallback, and short-data fallback. Also includes
 * skipped tests for production oracle checks (stale, wide confidence,
 * wrong feed ID) that require a non-mock build.
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

import {
  DEFAULT_LIQUIDATION_THRESHOLD_BPS,
  DEFAULT_MAX_LEVERAGE,
  DEFAULT_MAX_TVL,
  DEFAULT_PROTOCOL_FEE_BPS,
  Side,
  SOL_DECIMALS,
  USDC_DECIMALS,
} from "./helpers/ids";
import {
  buildAtomicOpenIx,
  buildInitializeIx,
  buildMigrateConfigV3Ix,
  buildSetTestConfigIx,
  decodePosition,
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

const RESERVE_USDC = 100_000n * 10n ** BigInt(USDC_DECIMALS);
const ONE_SOL = 1n * 10n ** BigInt(SOL_DECIMALS);

async function sendTx(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  return sendAndConfirmTransaction(conn, tx, signers);
}

describe("oracle_validation", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  const admin = Keypair.generate();
  const feeRecipient = Keypair.generate();

  // Unique user per test to avoid PDA reuse
  const user1 = Keypair.generate(); // custom price
  const user2 = Keypair.generate(); // updated price
  const user3 = Keypair.generate(); // zero price fallback
  const user4 = Keypair.generate(); // short data fallback

  let solMint: PublicKey;
  let usdcMint: PublicKey;
  let jlpMint: PublicKey;
  let msolMint: PublicKey;
  let solVault: PublicKey;
  let usdcReserve: PublicKey;
  let jlpVault: PublicKey;
  let msolVault: PublicKey;
  let feeUsdcAccount: PublicKey;

  before(async () => {
    // Fund admin + users
    await airdrop(connection, admin.publicKey, 100);
    for (const u of [user1, user2, user3, user4, feeRecipient]) {
      await airdrop(connection, u.publicKey, 10);
    }

    // Create mints
    solMint = await createTestMint(connection, admin, SOL_DECIMALS);
    usdcMint = await createTestMint(connection, admin, USDC_DECIMALS);
    jlpMint = await createTestMint(connection, admin, 6);
    msolMint = await createTestMint(connection, admin, SOL_DECIMALS);

    // PDA-owned vaults
    solVault = await createPdaOwnedTokenAccount(connection, admin, solMint);
    usdcReserve = await createPdaOwnedTokenAccount(connection, admin, usdcMint);
    jlpVault = await createPdaOwnedTokenAccount(connection, admin, jlpMint);
    msolVault = await createPdaOwnedTokenAccount(connection, admin, msolMint);

    // Fee recipient USDC token account
    feeUsdcAccount = await getOrCreateAta(connection, admin, usdcMint, feeRecipient.publicKey);

    // Seed reserve + vault
    await mintToken(connection, admin, usdcMint, usdcReserve, admin, RESERVE_USDC);
    await mintToken(connection, admin, solMint, solVault, admin, 1000n * ONE_SOL);

    // Default oracle at $150
    const defaultOracle = await createMockOracleAccount(connection, admin, 150_000_000n, 10_000n);

    // Initialize
    const initIx = buildInitializeIx({
      authority: admin.publicKey,
      solVault,
      usdcReserve,
      params: {
        feeRecipient: feeRecipient.publicKey,
        pythSolFeed: defaultOracle.publicKey,
        solMint,
        usdcMint,
        maxLeverage: DEFAULT_MAX_LEVERAGE,
        liquidationThreshold: DEFAULT_LIQUIDATION_THRESHOLD_BPS,
        protocolFeeBps: DEFAULT_PROTOCOL_FEE_BPS,
        maxTvl: DEFAULT_MAX_TVL,
      },
    });
    await sendTx(connection, new Transaction().add(initIx), [admin]);

    // Migrate to V3
    const migrateIx = buildMigrateConfigV3Ix({
      authority: admin.publicKey,
      jlpMint,
      jlpVault,
      msolMint,
      msolVault,
      pythMsolFeed: defaultOracle.publicKey,
    });
    await sendTx(connection, new Transaction().add(migrateIx), [admin]);

    // Create token accounts for all users + mint SOL & USDC
    for (const u of [user1, user2, user3, user4]) {
      const userSol = await getOrCreateAta(connection, admin, solMint, u.publicKey);
      const userUsdc = await getOrCreateAta(connection, admin, usdcMint, u.publicKey);
      await mintToken(connection, admin, solMint, userSol, admin, 10n * ONE_SOL);
      await mintToken(connection, admin, usdcMint, userUsdc, admin, 1_000_000_000n); // 1000 USDC
    }
  });

  /** Open a SOL long with the given oracle and return the entry price. */
  async function openWithOracle(user: Keypair, oracle: PublicKey): Promise<bigint> {
    const userSol = await getOrCreateAta(connection, admin, solMint, user.publicKey);
    const userUsdc = await getOrCreateAta(connection, admin, usdcMint, user.publicKey);

    const ix = buildAtomicOpenIx({
      user: user.publicKey,
      userCollateralAccount: userSol,
      collateralVault: solVault,
      userUsdcAccount: userUsdc,
      usdcReserve,
      feeRecipientAccount: feeUsdcAccount,
      pythPriceFeed: oracle,
      collateralAmount: ONE_SOL,
      borrowAmount: 100_000_000n, // 100 USDC
      perpSide: Side.Long,
      leverageBps: 5000,
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
    });
    await sendTx(connection, new Transaction().add(ix), [user]);

    const [positionPda] = findPositionPda(user.publicKey);
    const posData = await connection.getAccountInfo(positionPda);
    const position = decodePosition(posData!.data as Buffer);
    return position.entryPrice;
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

  // ===== Active tests (mock-oracle build) =====

  it("reads custom price from oracle account data", async () => {
    // Oracle at $200 → position should record entryPrice = 200_000_000
    const oracle = await createMockOracleAccount(connection, admin, 200_000_000n, 10_000n);
    const entryPrice = await openWithOracle(user1, oracle.publicKey);
    expect(entryPrice).to.equal(200_000_000n);
  });

  it("reads updated price after oracle write", async () => {
    // Create oracle at $150, update to $175, open → entryPrice = 175_000_000
    const oracle = await createMockOracleAccount(connection, admin, 150_000_000n, 10_000n);
    await updateOraclePrice(connection, admin, oracle, 175_000_000n, 10_000n);
    const entryPrice = await openWithOracle(user2, oracle.publicKey);
    expect(entryPrice).to.equal(175_000_000n);
  });

  it("oracle with zero price falls back to $150", async () => {
    // price=0 in 16-byte account → mock_read_price condition (price > 0) false → fallback
    const oracle = await createMockOracleAccount(connection, admin, 0n, 0n);
    const entryPrice = await openWithOracle(user3, oracle.publicKey);
    expect(entryPrice).to.equal(150_000_000n);
  });

  it("oracle with < 16 bytes falls back to $150", async () => {
    // System account has 0 data bytes → data.len() < 16 → fallback to $150
    const entryPrice = await openWithOracle(user4, user4.publicKey);
    expect(entryPrice).to.equal(150_000_000n);
  });

  // ===== Production oracle checks (require non-mock build) =====

  it.skip("rejects stale oracle (>5s)", async () => {
    // Requires non-mock build — mock oracle ignores publish_time / staleness
  });

  it.skip("rejects wide confidence (>1%)", async () => {
    // Requires non-mock build — mock oracle ignores confidence ratio check
  });

  it.skip("rejects wrong feed ID", async () => {
    // Requires non-mock build — mock oracle ignores feed ID validation
  });
});
