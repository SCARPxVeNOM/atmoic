import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import BN from "bn.js";

import { programId } from "./connection";
import { findAuthorityPda, findConfigPda, findPositionPda } from "./pdas";

/** Anchor discriminator: sha256("global:<ix_name>")[..8] */
function discriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

function writeU64LE(n: bigint | number | BN): Buffer {
  const b = Buffer.alloc(8);
  const bn = new BN(typeof n === "bigint" ? n.toString() : n);
  b.set(bn.toArrayLike(Buffer, "le", 8));
  return b;
}

function writeU8(n: number): Buffer {
  return Buffer.from([n & 0xff]);
}

function writeU16LE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
}

function writeVecU8(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  return Buffer.concat([len, data]);
}

export enum Side {
  Long = 0,
  Short = 1,
}

// ----- update_config -----

export interface UpdateConfigArgs {
  authority: PublicKey;
  newAuthority?: PublicKey;
  newFeeRecipient?: PublicKey;
  protocolFeeBps?: number;
  maxLeverage?: number;
  liquidationThreshold?: number;
  maxTvl?: bigint;
  isPaused?: boolean;
  totalUsdcReserve?: bigint;
  psfBalance?: bigint;
  stressActive?: boolean; // V3: stress circuit breaker flag
}

export function buildUpdateConfigIx(args: UpdateConfigArgs): TransactionInstruction {
  const [config] = findConfigPda();
  const NO_CHANGE_PK = PublicKey.default;
  const NO_CHANGE_U64 = BigInt("18446744073709551615"); // u64::MAX
  const NO_CHANGE_BOOL = 255;

  const data = Buffer.concat([
    discriminator("update_config"),
    (args.newAuthority ?? NO_CHANGE_PK).toBuffer(),
    (args.newFeeRecipient ?? NO_CHANGE_PK).toBuffer(),
    writeU64LE(args.protocolFeeBps !== undefined ? BigInt(args.protocolFeeBps) : NO_CHANGE_U64),
    writeU64LE(args.maxLeverage !== undefined ? BigInt(args.maxLeverage) : NO_CHANGE_U64),
    writeU64LE(args.liquidationThreshold !== undefined ? BigInt(args.liquidationThreshold) : NO_CHANGE_U64),
    writeU64LE(args.maxTvl !== undefined ? args.maxTvl : NO_CHANGE_U64),
    writeU8(args.isPaused !== undefined ? (args.isPaused ? 1 : 0) : NO_CHANGE_BOOL),
    writeU64LE(args.totalUsdcReserve !== undefined ? args.totalUsdcReserve : NO_CHANGE_U64),
    writeU64LE(args.psfBalance !== undefined ? args.psfBalance : NO_CHANGE_U64),
    // V3: stress_active byte (255 = no change)
    writeU8(args.stressActive !== undefined ? (args.stressActive ? 1 : 0) : NO_CHANGE_BOOL),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ----- atomic_open -----

export interface AccountMetaJson {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

export interface AtomicOpenArgs {
  user: PublicKey;
  userCollateralAccount: PublicKey; // renamed from userSolAccount
  userUsdcAccount: PublicKey;
  collateralVault: PublicKey;       // renamed from solVault
  usdcReserve: PublicKey;
  feeRecipientAccount: PublicKey;
  pythPriceFeed: PublicKey;
  collateralAmount: bigint;
  borrowAmount: bigint;
  perpSide: Side;
  leverageBps: number;
  hedgeAmount: bigint;
  spreadFeeBps: number;
  jupiterSwapData: Buffer;
  jupiterRemainingAccounts?: AccountMetaJson[];
  kaminoBorrowData?: Buffer;
  kaminoRemainingAccounts?: AccountMetaJson[];
  // V3: multi-collateral
  collateralType?: number;          // 0=SOL, 1=JLP, 2=mSOL (default 0)
  jlpPrice?: bigint;                // JLP price in 6dp (only for type=1)
  msolFeedAccount?: PublicKey;      // Pyth mSOL feed (only for type=2)
}

export function buildAtomicOpenIx(args: AtomicOpenArgs): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.user);

  const collType = args.collateralType ?? 0;
  const data = Buffer.concat([
    discriminator("atomic_open"),
    writeU64LE(args.collateralAmount),
    writeU64LE(args.borrowAmount),
    writeU8(args.perpSide),
    writeU64LE(args.leverageBps),
    writeU64LE(args.hedgeAmount),
    writeU16LE(args.spreadFeeBps),
    writeVecU8(args.jupiterSwapData),
    writeVecU8(args.kaminoBorrowData ?? Buffer.alloc(0)),
    // V3 extension: collateral_type + jlp_price
    writeU8(collType),
    writeU64LE(args.jlpPrice ?? BigInt(0)),
  ]);

  // For mSOL: msolFeedAccount goes first in remaining_accounts
  const extraRemaining: AccountMetaJson[] = [];
  if (collType === 2 && args.msolFeedAccount) {
    extraRemaining.push({ pubkey: args.msolFeedAccount, isSigner: false, isWritable: false });
  }

  const keys = [
    { pubkey: args.user, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
    { pubkey: args.userCollateralAccount, isSigner: false, isWritable: true },
    { pubkey: args.collateralVault, isSigner: false, isWritable: true },
    { pubkey: args.usdcReserve, isSigner: false, isWritable: true },
    { pubkey: args.userUsdcAccount, isSigner: false, isWritable: true },
    { pubkey: args.feeRecipientAccount, isSigner: false, isWritable: true },
    { pubkey: programAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // mSOL Pyth feed (if applicable), then Kamino, then Jupiter
    ...extraRemaining,
    ...(args.kaminoRemainingAccounts ?? []),
    ...(args.jupiterRemainingAccounts ?? []),
  ];

  return new TransactionInstruction({ programId, keys, data });
}

// ----- atomic_close -----

export interface AtomicCloseArgs {
  user: PublicKey;
  userCollateralAccount: PublicKey;  // renamed from userSolAccount
  userUsdcAccount: PublicKey;
  collateralVault: PublicKey;        // renamed from solVault
  usdcReserve: PublicKey;
  feeRecipientAccount: PublicKey;
  pythPriceFeed: PublicKey;
  kaminoRepayData?: Buffer;
  kaminoRemainingAccounts?: AccountMetaJson[];
  // V3: collateral price for JLP settlement (0 = use oracle)
  collateralPrice?: bigint;
  msolFeedAccount?: PublicKey;       // Pyth mSOL feed (only for mSOL collateral)
}

export function buildAtomicCloseIx(args: AtomicCloseArgs): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.user);

  const data = Buffer.concat([
    discriminator("atomic_close"),
    writeVecU8(args.kaminoRepayData ?? Buffer.alloc(0)),
    // V3 extension: collateral_price_6dp
    writeU64LE(args.collateralPrice ?? BigInt(0)),
  ]);

  // For mSOL: feed account in remaining_accounts before Kamino
  const extraRemaining: AccountMetaJson[] = [];
  if (args.msolFeedAccount) {
    extraRemaining.push({ pubkey: args.msolFeedAccount, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
      { pubkey: args.userUsdcAccount, isSigner: false, isWritable: true },
      { pubkey: args.usdcReserve, isSigner: false, isWritable: true },
      { pubkey: args.collateralVault, isSigner: false, isWritable: true },
      { pubkey: args.userCollateralAccount, isSigner: false, isWritable: true },
      { pubkey: args.feeRecipientAccount, isSigner: false, isWritable: true },
      { pubkey: programAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...extraRemaining,
      ...(args.kaminoRemainingAccounts ?? []),
    ],
    data,
  });
}

// ----- liquidate -----

export function buildLiquidateIx(args: {
  liquidator: PublicKey;
  positionOwner: PublicKey;
  liquidatorCollateralAccount: PublicKey;  // renamed: works for any collateral
  collateralVault: PublicKey;              // renamed: matches position's collateral type
  feeRecipientCollateralAccount: PublicKey;
  pythPriceFeed: PublicKey;
  kaminoRepayData?: Buffer;
  kaminoRemainingAccounts?: AccountMetaJson[];
  // V3: collateral price for JLP (0 = use oracle)
  collateralPrice?: bigint;
  msolFeedAccount?: PublicKey;
}): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.positionOwner);

  const data = Buffer.concat([
    discriminator("liquidate"),
    writeVecU8(args.kaminoRepayData ?? Buffer.alloc(0)),
    // V3 extension: collateral_price_6dp
    writeU64LE(args.collateralPrice ?? BigInt(0)),
  ]);

  // For mSOL: feed account in remaining_accounts before Kamino
  const extraRemaining: AccountMetaJson[] = [];
  if (args.msolFeedAccount) {
    extraRemaining.push({ pubkey: args.msolFeedAccount, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.liquidator, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
      { pubkey: args.collateralVault, isSigner: false, isWritable: true },
      { pubkey: args.liquidatorCollateralAccount, isSigner: false, isWritable: true },
      { pubkey: args.feeRecipientCollateralAccount, isSigner: false, isWritable: true },
      { pubkey: programAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...extraRemaining,
      ...(args.kaminoRemainingAccounts ?? []),
    ],
    data,
  });
}

// ----- DFBA PDA helpers -----

const COMMITMENT_SEED = Buffer.from("commitment");
const QUEUE_SEED = Buffer.from("queue");

export function findCommitmentPda(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([COMMITMENT_SEED, user.toBuffer()], programId);
}

export function findQueueShardPda(market: number, side: number, shard: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [QUEUE_SEED, Buffer.from([market, side, shard])],
    programId,
  );
}

/** Deterministic shard routing per M-3: user_pubkey[0] % 8 */
export function getShardIndex(user: PublicKey): number {
  return user.toBuffer()[0] % 8;
}

// ----- execute_batch (DFBA) -----

export function buildExecuteBatchIx(args: {
  cranker: PublicKey;
  pythPriceFeed: PublicKey;
  queueShards: PublicKey[];
}): TransactionInstruction {
  const [config] = findConfigPda();

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.cranker, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
      ...args.queueShards.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true })),
    ],
    data: discriminator("execute_batch"),
  });
}

// ----- place_order (DFBA) -----

export function buildPlaceOrderIx(args: {
  user: PublicKey;
  queueShard: PublicKey;
  price: bigint;
  size: bigint;
}): TransactionInstruction {
  const data = Buffer.concat([
    discriminator("place_commitment"), // reuses same discriminator slot
    writeU64LE(args.price),
    writeU64LE(args.size),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: args.queueShard, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ----- cancel_order (DFBA) -----

export function buildCancelOrderIx(args: {
  user: PublicKey;
  queueShard: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: args.queueShard, isSigner: false, isWritable: true },
    ],
    data: discriminator("cancel_order"),
  });
}
