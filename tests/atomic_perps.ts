/**
 * Integration tests for atomic_perps.
 *
 * These tests exercise the synthetic MVP flow end-to-end:
 *   initialize → atomic_open → atomic_close
 * plus a handful of negative safety checks.
 *
 * They require the program to be built with the `mock-oracle` feature so that
 * `validate_and_get_price` returns a constant $150 SOL/USD price without needing
 * a live Pyth feed:
 *
 *   anchor build --no-idl -- --features mock-oracle
 *   # then (Anchor.toml [test.validator] clone directives may be commented out
 *   # since we don't hit real Pyth/Kamino/Jupiter in mock mode)
 *   anchor test --skip-build
 *
 * Or, against a manually-run validator:
 *
 *   solana-test-validator --reset
 *   solana program deploy target/deploy/atomic_perps.so
 *   yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/atomic_perps.ts
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
} from "./helpers/ids";
import {
  buildAtomicCloseIx,
  buildAtomicOpenIx,
  buildInitializeIx,
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

// === Test constants ==========================================================

// Mock oracle returns $150/SOL in 6dp, so 1 SOL = 150 USDC of collateral value.
const MOCK_SOL_PRICE_USDC = 150n;

// User starts with 10 SOL of "SOL" test mint (9dp) and 0 USDC.
const USER_SOL_BALANCE = 10n * 10n ** BigInt(SOL_DECIMALS);

// Pre-fund the usdc_reserve with 100k USDC so atomic_open has liquidity.
const RESERVE_USDC_BALANCE = 100_000n * 10n ** BigInt(USDC_DECIMALS);

// Happy-path open: 1 SOL collateral ($150), borrow 100 USDC → ~6.66x implied leverage.
const OPEN_COLLATERAL = 1n * 10n ** BigInt(SOL_DECIMALS); // 1 SOL
const OPEN_BORROW = 100n * 10n ** BigInt(USDC_DECIMALS); // 100 USDC

describe("atomic_perps", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  // Test actors — fresh for each run.
  const admin = Keypair.generate();
  const user = Keypair.generate();
  const feeRecipient = Keypair.generate();

  // Created during setup.
  let solMint: PublicKey;
  let usdcMint: PublicKey;
  let solVault: PublicKey;
  let usdcReserve: PublicKey;
  let userSolAccount: PublicKey;
  let userUsdcAccount: PublicKey;
  let feeRecipientUsdcAccount: PublicKey;

  const [configPda] = findConfigPda();
  const [positionPda] = findPositionPda(user.publicKey);

  // Mock oracle doesn't read the feed account, so we use SystemProgram as a
  // stable, always-present placeholder that satisfies the `address = ...`
  // constraint in atomic_open/close/liquidate.
  const mockPythFeed = SystemProgram.programId;

  before("bootstrap validator state", async () => {
    // Airdrop SOL to everyone who will sign transactions.
    await airdrop(connection, admin.publicKey, 10);
    await airdrop(connection, user.publicKey, 10);
    await airdrop(connection, feeRecipient.publicKey, 1);

    // Create the "SOL" and "USDC" test mints. Admin is both payer and mint
    // authority so we can mint into the reserve during setup.
    solMint = await createTestMint(connection, admin, SOL_DECIMALS);
    usdcMint = await createTestMint(connection, admin, USDC_DECIMALS);

    // Pre-create the protocol-owned token accounts. Their authority must be
    // the program_authority PDA; initialize will verify this constraint.
    solVault = await createPdaOwnedTokenAccount(connection, admin, solMint);
    usdcReserve = await createPdaOwnedTokenAccount(connection, admin, usdcMint);

    // Fund the reserve BEFORE initialize so total_usdc_reserve is set correctly.
    await mintToken(connection, admin, usdcMint, usdcReserve, admin, RESERVE_USDC_BALANCE);

    // User-side token accounts.
    userSolAccount = await getOrCreateAta(connection, user, solMint, user.publicKey);
    userUsdcAccount = await getOrCreateAta(connection, user, usdcMint, user.publicKey);
    await mintToken(connection, admin, solMint, userSolAccount, admin, USER_SOL_BALANCE);

    // Fee recipient gets a USDC ATA so atomic_open can send the fee there.
    feeRecipientUsdcAccount = await getOrCreateAta(
      connection,
      admin,
      usdcMint,
      feeRecipient.publicKey
    );
  });

  // ---------------------------------------------------------------------------
  // initialize
  // ---------------------------------------------------------------------------
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

    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [admin]);

    const configAccount = await connection.getAccountInfo(configPda);
    expect(configAccount, "config account exists").to.not.be.null;
    expect(configAccount!.owner.equals(ATOMIC_PERPS_PROGRAM_ID)).to.equal(true);

    const cfg = decodeGlobalConfig(configAccount!.data);
    expect(cfg.authority.equals(admin.publicKey)).to.equal(true);
    expect(cfg.feeRecipient.equals(feeRecipient.publicKey)).to.equal(true);
    expect(cfg.solMint.equals(solMint)).to.equal(true);
    expect(cfg.usdcMint.equals(usdcMint)).to.equal(true);
    expect(cfg.isPaused).to.equal(false);
    expect(cfg.maxLeverage).to.equal(BigInt(DEFAULT_MAX_LEVERAGE));
    expect(cfg.totalUsdcReserve).to.equal(RESERVE_USDC_BALANCE);
    expect(cfg.totalUsdcBorrowed).to.equal(0n);
  });

  // ---------------------------------------------------------------------------
  // atomic_open — happy path
  // ---------------------------------------------------------------------------
  it("opens a synthetic long atomically", async () => {
    const vaultSolBefore = (await getAccount(connection, solVault)).amount;
    const reserveBefore = (await getAccount(connection, usdcReserve)).amount;
    const userUsdcBefore = (await getAccount(connection, userUsdcAccount)).amount;
    const feeRecipientBefore = (await getAccount(connection, feeRecipientUsdcAccount)).amount;

    const ix = buildAtomicOpenIx({
      user: user.publicKey,
      userSolAccount,
      userUsdcAccount,
      solVault,
      usdcReserve,
      feeRecipientAccount: feeRecipientUsdcAccount,
      pythPriceFeed: mockPythFeed,
      collateralAmount: OPEN_COLLATERAL,
      borrowAmount: OPEN_BORROW,
      perpSide: Side.Long,
      leverageBps: 5_000, // 5x
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [user]);

    // Position PDA should exist and hold the expected fields.
    const positionAccount = await connection.getAccountInfo(positionPda);
    expect(positionAccount, "position created").to.not.be.null;
    const pos = decodePosition(positionAccount!.data);
    expect(pos.owner.equals(user.publicKey)).to.equal(true);
    expect(pos.collateralAmount).to.equal(OPEN_COLLATERAL);
    expect(pos.borrowAmountUsdc).to.equal(OPEN_BORROW);
    expect(pos.perpSide).to.equal(Side.Long);
    expect(pos.isOpen).to.equal(true);
    // Entry price should be the mock $150 (6dp).
    expect(pos.entryPrice).to.equal(MOCK_SOL_PRICE_USDC * 1_000_000n);

    // Token balance deltas.
    const vaultSolAfter = (await getAccount(connection, solVault)).amount;
    const reserveAfter = (await getAccount(connection, usdcReserve)).amount;
    const userUsdcAfter = (await getAccount(connection, userUsdcAccount)).amount;
    const feeRecipientAfter = (await getAccount(connection, feeRecipientUsdcAccount)).amount;

    // Collateral moved user -> vault.
    expect(vaultSolAfter - vaultSolBefore).to.equal(OPEN_COLLATERAL);

    // Fee split: protocol (10 bps) + spread (5 bps default) = 15 bps of 100 USDC.
    // PSF accrual: 10% of fee stays in reserve, 90% goes to fee_recipient.
    const SPREAD_FEE_BPS = 5n;
    const totalFeeBps = BigInt(DEFAULT_PROTOCOL_FEE_BPS) + SPREAD_FEE_BPS;
    const feeAmount = (OPEN_BORROW * totalFeeBps) / 10_000n;
    const psfPortion = feeAmount / 10n;
    const recipientFee = feeAmount - psfPortion;
    const userRecv = OPEN_BORROW - feeAmount;

    expect(userUsdcAfter - userUsdcBefore).to.equal(userRecv);
    expect(feeRecipientAfter - feeRecipientBefore).to.equal(recipientFee);
    // Reserve outflow = user_recv + recipient_fee = OPEN_BORROW - psfPortion
    expect(reserveBefore - reserveAfter).to.equal(OPEN_BORROW - psfPortion);

    // Global accounting.
    const cfg = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
    expect(cfg.totalUsdcBorrowed).to.equal(OPEN_BORROW);
  });

  // ---------------------------------------------------------------------------
  // atomic_open — safety: duplicate open rejected
  // ---------------------------------------------------------------------------
  it("rejects opening a second position for the same user (PDA already exists)", async () => {
    const ix = buildAtomicOpenIx({
      user: user.publicKey,
      userSolAccount,
      userUsdcAccount,
      solVault,
      usdcReserve,
      feeRecipientAccount: feeRecipientUsdcAccount,
      pythPriceFeed: mockPythFeed,
      collateralAmount: OPEN_COLLATERAL,
      borrowAmount: OPEN_BORROW,
      perpSide: Side.Long,
      leverageBps: 5_000,
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
    });

    let threw = false;
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(ix), [user]);
    } catch (e) {
      threw = true;
    }
    expect(threw, "second open should fail because Position PDA is already initialized").to.equal(
      true
    );
  });

  // ---------------------------------------------------------------------------
  // atomic_close — happy path
  // ---------------------------------------------------------------------------
  it("closes the position with zero PnL at constant price", async () => {
    // User must hold enough USDC to repay the borrow. They already received
    // 99.9 USDC (100 minus 10bps fee). We top them up so they can repay the full 100.
    await mintTo(connection, admin, usdcMint, userUsdcAccount, admin, 1_000_000); // +1 USDC

    const vaultSolBefore = (await getAccount(connection, solVault)).amount;
    const userSolBefore = (await getAccount(connection, userSolAccount)).amount;
    const reserveBefore = (await getAccount(connection, usdcReserve)).amount;
    const userUsdcBefore = (await getAccount(connection, userUsdcAccount)).amount;
    const feeRecipientBefore = (await getAccount(connection, feeRecipientUsdcAccount)).amount;

    const ix = buildAtomicCloseIx({
      user: user.publicKey,
      userSolAccount,
      userUsdcAccount,
      solVault,
      usdcReserve,
      feeRecipientAccount: feeRecipientUsdcAccount,
      pythPriceFeed: mockPythFeed,
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [user]);

    const pos = decodePosition((await connection.getAccountInfo(positionPda))!.data);
    expect(pos.isOpen).to.equal(false);
    expect(pos.collateralAmount).to.equal(0n);
    expect(pos.borrowAmountUsdc).to.equal(0n);

    const vaultSolAfter = (await getAccount(connection, solVault)).amount;
    const userSolAfter = (await getAccount(connection, userSolAccount)).amount;
    const reserveAfter = (await getAccount(connection, usdcReserve)).amount;
    const userUsdcAfter = (await getAccount(connection, userUsdcAccount)).amount;
    const feeRecipientAfter = (await getAccount(connection, feeRecipientUsdcAccount)).amount;

    // Zero PnL at constant mock price → user gets back exactly their collateral.
    expect(vaultSolBefore - vaultSolAfter).to.equal(OPEN_COLLATERAL);
    expect(userSolAfter - userSolBefore).to.equal(OPEN_COLLATERAL);

    // User repaid the full notional borrow.
    expect(userUsdcBefore - userUsdcAfter).to.equal(OPEN_BORROW);

    // Reserve net delta: +borrow (user repay) -recipientFee (close fee paid out).
    // PSF keeps 10% of fee in reserve, 90% goes to fee_recipient.
    const closeFee = (OPEN_BORROW * BigInt(DEFAULT_PROTOCOL_FEE_BPS)) / 10_000n;
    const closePsf = closeFee / 10n;
    const closeRecipientFee = closeFee - closePsf;
    expect(reserveAfter - reserveBefore).to.equal(OPEN_BORROW - closeRecipientFee);
    expect(feeRecipientAfter - feeRecipientBefore).to.equal(closeRecipientFee);

    // Global accounting reset.
    const cfg = decodeGlobalConfig((await connection.getAccountInfo(configPda))!.data);
    expect(cfg.totalUsdcBorrowed).to.equal(0n);
  });

  // ---------------------------------------------------------------------------
  // atomic_open — safety: excessive leverage rejected
  // ---------------------------------------------------------------------------
  it("rejects atomic_open when implied leverage exceeds max_leverage", async () => {
    // After close, the user can open a new position. But Anchor `init` on a
    // PDA requires the account to be closed first — our close handler doesn't
    // close the Position PDA, just marks is_open=false. So this re-init will
    // fail with "already in use" BEFORE even reaching the leverage check.
    //
    // To exercise the leverage check in isolation we use a fresh user whose
    // position PDA has never been initialized.
    const secondUser = Keypair.generate();
    await airdrop(connection, secondUser.publicKey, 5);

    const u2Sol = await getOrCreateAta(connection, secondUser, solMint, secondUser.publicKey);
    const u2Usdc = await getOrCreateAta(connection, secondUser, usdcMint, secondUser.publicKey);
    // Give them 0.1 SOL → $15 collateral value.
    await mintToken(connection, admin, solMint, u2Sol, admin, 10n ** 8n); // 0.1 SOL

    // Try to borrow 1000 USDC against $15 collateral → implied leverage ~66x,
    // far above the 10x (10_000 bps) max.
    const ix = buildAtomicOpenIx({
      user: secondUser.publicKey,
      userSolAccount: u2Sol,
      userUsdcAccount: u2Usdc,
      solVault,
      usdcReserve,
      feeRecipientAccount: feeRecipientUsdcAccount,
      pythPriceFeed: mockPythFeed,
      collateralAmount: 10n ** 8n, // 0.1 SOL
      borrowAmount: 1_000n * 10n ** BigInt(USDC_DECIMALS),
      perpSide: Side.Long,
      leverageBps: 5_000,
      hedgeAmount: 0n,
      jupiterSwapData: Buffer.alloc(0),
    });

    let threw = false;
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(ix), [secondUser]);
    } catch (e) {
      threw = true;
    }
    expect(threw, "excessive leverage should be rejected").to.equal(true);
  });

  // ---------------------------------------------------------------------------
  // Liquidation is exercised in the mainnet e2e suite, not here: with a
  // constant mock price it's impossible to construct a position that passes
  // the open-time health check yet fails the liquidation-time health check.
  // ---------------------------------------------------------------------------
  it.skip("liquidates an unhealthy position (requires variable oracle price)", () => {
    /* see backend/tests/liquidator.e2e.ts */
  });
});
