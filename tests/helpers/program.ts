import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import BN from "bn.js";
import {
  ATOMIC_PERPS_PROGRAM_ID,
  AUTHORITY_SEED,
  CONFIG_SEED,
  POSITION_SEED,
  Side,
} from "./ids";

/** Anchor instruction discriminator: sha256("global:<ix_name>")[..8] */
function discriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

// Manual account discriminators for our two PDAs — must match
// programs/atomic_perps/src/utils/account.rs constants.
const GLOBAL_CONFIG_DISC = Buffer.from([0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8]);
const POSITION_DISC = Buffer.from([0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8]);

// ===== PDA helpers =====

export function findConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], ATOMIC_PERPS_PROGRAM_ID);
}

export function findAuthorityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AUTHORITY_SEED], ATOMIC_PERPS_PROGRAM_ID);
}

export function findPositionPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, owner.toBuffer()],
    ATOMIC_PERPS_PROGRAM_ID
  );
}

// ===== Borsh-ish encoders =====

function writeU64LE(n: bigint | number | BN): Buffer {
  const b = Buffer.alloc(8);
  const bn = new BN(typeof n === "bigint" ? n.toString() : n);
  b.set(bn.toArrayLike(Buffer, "le", 8));
  return b;
}

function writeU8(n: number): Buffer {
  return Buffer.from([n & 0xff]);
}

function writePubkey(pk: PublicKey): Buffer {
  return pk.toBuffer();
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

// ===== Instruction builders =====

export interface InitializeParams {
  feeRecipient: PublicKey;
  pythSolFeed: PublicKey;
  solMint: PublicKey;
  usdcMint: PublicKey;
  maxLeverage: number;
  liquidationThreshold: number;
  protocolFeeBps: number;
  maxTvl: bigint;
}

export function buildInitializeIx(args: {
  authority: PublicKey;
  solVault: PublicKey;
  usdcReserve: PublicKey;
  params: InitializeParams;
}): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();

  const data = Buffer.concat([
    discriminator("initialize"),
    writePubkey(args.params.feeRecipient),
    writePubkey(args.params.pythSolFeed),
    writePubkey(args.params.solMint),
    writePubkey(args.params.usdcMint),
    writeU64LE(args.params.maxLeverage),
    writeU64LE(args.params.liquidationThreshold),
    writeU64LE(args.params.protocolFeeBps),
    writeU64LE(args.params.maxTvl),
  ]);

  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: programAuthority, isSigner: false, isWritable: false },
      { pubkey: args.solVault, isSigner: false, isWritable: false },
      { pubkey: args.usdcReserve, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface AtomicOpenArgs {
  user: PublicKey;
  userUsdcAccount: PublicKey;
  usdcReserve: PublicKey;
  feeRecipientAccount: PublicKey;
  pythPriceFeed: PublicKey;
  collateralAmount: bigint;
  borrowAmount: bigint;
  perpSide: Side;
  leverageBps: number;
  hedgeAmount: bigint;
  spreadFeeBps?: number;
  jupiterSwapData: Buffer;
  jupiterRemainingAccounts?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  kaminoBorrowData?: Buffer;
  kaminoRemainingAccounts?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  // V3: multi-collateral
  collateralType?: number;          // 0=SOL, 1=JLP, 2=mSOL (default 0)
  jlpPrice?: bigint;                // JLP price in 6dp (only for type=1)
  msolFeedAccount?: PublicKey;      // Pyth mSOL feed (only for type=2)
  // Collateral account + vault: accept either new or legacy field name
  userCollateralAccount?: PublicKey;
  collateralVault?: PublicKey;
  userSolAccount?: PublicKey;
  solVault?: PublicKey;
}

export function buildAtomicOpenIx(args: AtomicOpenArgs): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.user);

  // Support legacy field names for backward compat with existing tests
  const userCollateralAccount = args.userCollateralAccount ?? args.userSolAccount!;
  const collateralVault = args.collateralVault ?? args.solVault!;

  const data = Buffer.concat([
    discriminator("atomic_open"),
    writeU64LE(args.collateralAmount),
    writeU64LE(args.borrowAmount),
    writeU8(args.perpSide),
    writeU64LE(args.leverageBps),
    writeU64LE(args.hedgeAmount),
    writeU16LE(args.spreadFeeBps ?? 5),
    writeVecU8(args.jupiterSwapData),
    writeVecU8(args.kaminoBorrowData ?? Buffer.alloc(0)),
    // V3: collateral_type + jlp_price appended after vec data
    writeU8(args.collateralType ?? 0),
    writeU64LE(args.jlpPrice ?? 0n),
  ]);

  // Build remaining_accounts: mSOL feed (if present) before kamino/jupiter
  const extraRemaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  if (args.msolFeedAccount) {
    extraRemaining.push({ pubkey: args.msolFeedAccount, isSigner: false, isWritable: false });
  }

  const keys = [
    { pubkey: args.user, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
    { pubkey: userCollateralAccount, isSigner: false, isWritable: true },
    { pubkey: collateralVault, isSigner: false, isWritable: true },
    { pubkey: args.usdcReserve, isSigner: false, isWritable: true },
    { pubkey: args.userUsdcAccount, isSigner: false, isWritable: true },
    { pubkey: args.feeRecipientAccount, isSigner: false, isWritable: true },
    { pubkey: programAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...extraRemaining,
    ...(args.kaminoRemainingAccounts ?? []),
    ...(args.jupiterRemainingAccounts ?? []),
  ];

  return new TransactionInstruction({ programId: ATOMIC_PERPS_PROGRAM_ID, keys, data });
}

export function buildAtomicCloseIx(args: {
  user: PublicKey;
  userCollateralAccount?: PublicKey;
  userUsdcAccount: PublicKey;
  collateralVault?: PublicKey;
  usdcReserve: PublicKey;
  feeRecipientAccount: PublicKey;
  pythPriceFeed: PublicKey;
  kaminoRepayData?: Buffer;
  kaminoRemainingAccounts?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  collateralPrice?: bigint;
  msolFeedAccount?: PublicKey;
  // Legacy aliases
  userSolAccount?: PublicKey;
  solVault?: PublicKey;
}): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.user);

  const userCollateralAccount = args.userCollateralAccount ?? args.userSolAccount!;
  const collateralVault = args.collateralVault ?? args.solVault!;

  const data = Buffer.concat([
    discriminator("atomic_close"),
    writeVecU8(args.kaminoRepayData ?? Buffer.alloc(0)),
    writeU64LE(args.collateralPrice ?? 0n),
  ]);

  // Build remaining_accounts: mSOL feed (if present) before kamino
  const extraRemaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  if (args.msolFeedAccount) {
    extraRemaining.push({ pubkey: args.msolFeedAccount, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
      { pubkey: args.userUsdcAccount, isSigner: false, isWritable: true },
      { pubkey: args.usdcReserve, isSigner: false, isWritable: true },
      { pubkey: collateralVault, isSigner: false, isWritable: true },
      { pubkey: userCollateralAccount, isSigner: false, isWritable: true },
      { pubkey: args.feeRecipientAccount, isSigner: false, isWritable: true },
      { pubkey: programAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...extraRemaining,
      ...(args.kaminoRemainingAccounts ?? []),
    ],
    data,
  });
}

export function buildLiquidateIx(args: {
  liquidator: PublicKey;
  positionOwner: PublicKey;
  liquidatorCollateralAccount?: PublicKey;
  collateralVault?: PublicKey;
  feeRecipientCollateralAccount?: PublicKey;
  pythPriceFeed: PublicKey;
  kaminoRepayData?: Buffer;
  kaminoRemainingAccounts?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  collateralPrice?: bigint;
  msolFeedAccount?: PublicKey;
  // Legacy aliases
  liquidatorSolAccount?: PublicKey;
  solVault?: PublicKey;
  feeRecipientSolAccount?: PublicKey;
}): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.positionOwner);

  const liquidatorCollateral = args.liquidatorCollateralAccount ?? args.liquidatorSolAccount!;
  const collateralVault = args.collateralVault ?? args.solVault!;
  const feeRecipientCollateral = args.feeRecipientCollateralAccount ?? args.feeRecipientSolAccount!;

  // Build remaining_accounts: mSOL feed (if present) before kamino
  const extraRemaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  if (args.msolFeedAccount) {
    extraRemaining.push({ pubkey: args.msolFeedAccount, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.liquidator, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
      { pubkey: collateralVault, isSigner: false, isWritable: true },
      { pubkey: liquidatorCollateral, isSigner: false, isWritable: true },
      { pubkey: feeRecipientCollateral, isSigner: false, isWritable: true },
      { pubkey: programAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...extraRemaining,
      ...(args.kaminoRemainingAccounts ?? []),
    ],
    data: Buffer.concat([
      discriminator("liquidate"),
      writeVecU8(args.kaminoRepayData ?? Buffer.alloc(0)),
      writeU64LE(args.collateralPrice ?? 0n),
    ]),
  });
}

// ===== Account decoders =====
// Must match programs/atomic_perps/src/state.rs + utils/account.rs

function assertDisc(data: Buffer, expected: Buffer, label: string): void {
  if (data.length < 8 || !data.subarray(0, 8).equals(expected)) {
    throw new Error(`${label}: bad discriminator`);
  }
}

export interface GlobalConfigData {
  authority: PublicKey;
  feeRecipient: PublicKey;
  pythSolFeed: PublicKey;
  solMint: PublicKey;
  usdcMint: PublicKey;
  solVault: PublicKey;
  usdcReserve: PublicKey;
  isPaused: boolean;
  maxLeverage: bigint;
  liquidationThreshold: bigint;
  protocolFeeBps: bigint;
  maxTvl: bigint;
  totalUsdcBorrowed: bigint;
  totalUsdcReserve: bigint;
  bump: number;
  programAuthorityBump: number;
  // V2 fields
  totalLongOi: bigint;
  totalShortOi: bigint;
  psfBalance: bigint;
  // V3 fields
  jlpMint: PublicKey;
  jlpVault: PublicKey;
  msolMint: PublicKey;
  msolVault: PublicKey;
  pythMsolFeed: PublicKey;
  stressActive: boolean;
  totalCorrelatedCollateral: bigint;
  totalCollateral: bigint;
}

export function decodeGlobalConfig(data: Buffer): GlobalConfigData {
  assertDisc(data, GLOBAL_CONFIG_DISC, "GlobalConfig");
  const V2_SPACE = 299;
  const V3_SPACE = 476;
  let o = 8;
  const readPk = () => {
    const pk = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return pk;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const readU8 = () => {
    const v = data[o];
    o += 1;
    return v;
  };

  const authority = readPk();
  const feeRecipient = readPk();
  const pythSolFeed = readPk();
  const solMint = readPk();
  const usdcMint = readPk();
  const solVault = readPk();
  const usdcReserve = readPk();
  const isPaused = readU8() !== 0;
  const maxLeverage = readU64();
  const liquidationThreshold = readU64();
  const protocolFeeBps = readU64();
  const maxTvl = readU64();
  const totalUsdcBorrowed = readU64();
  const totalUsdcReserve = readU64();
  const bump = readU8();
  const programAuthorityBump = readU8();

  // V2 fields (offset 275..299)
  let totalLongOi = 0n, totalShortOi = 0n, psfBalance = 0n;
  if (data.length >= 8 + V2_SPACE) {
    totalLongOi = readU64();
    totalShortOi = readU64();
    psfBalance = readU64();
  }

  // V3 fields (offset 299..476)
  let jlpMint = PublicKey.default, jlpVault = PublicKey.default;
  let msolMint = PublicKey.default, msolVault = PublicKey.default;
  let pythMsolFeed = PublicKey.default;
  let stressActive = false;
  let totalCorrelatedCollateral = 0n, totalCollateral = 0n;
  if (data.length >= 8 + V3_SPACE) {
    jlpMint = readPk();
    jlpVault = readPk();
    msolMint = readPk();
    msolVault = readPk();
    pythMsolFeed = readPk();
    stressActive = readU8() !== 0;
    totalCorrelatedCollateral = readU64();
    totalCollateral = readU64();
  }

  return {
    authority, feeRecipient, pythSolFeed, solMint, usdcMint, solVault, usdcReserve,
    isPaused, maxLeverage, liquidationThreshold, protocolFeeBps, maxTvl,
    totalUsdcBorrowed, totalUsdcReserve, bump, programAuthorityBump,
    totalLongOi, totalShortOi, psfBalance,
    jlpMint, jlpVault, msolMint, msolVault, pythMsolFeed,
    stressActive, totalCorrelatedCollateral, totalCollateral,
  };
}

export interface PositionData {
  owner: PublicKey;
  perpMarket: PublicKey;
  collateralMint: PublicKey;
  kaminoObligation: PublicKey;
  collateralAmount: bigint;
  borrowAmountUsdc: bigint;
  perpSide: Side;
  perpSize: bigint;
  entryPrice: bigint;
  openedAt: bigint;
  hedgeAmount: bigint;
  isOpen: boolean;
  bump: number;
  // V3
  collateralEntryPrice: bigint;
}

export function decodePosition(data: Buffer): PositionData {
  assertDisc(data, POSITION_DISC, "Position");
  const V2_SIZE = 8 + 179; // disc + V2 layout
  const V3_SIZE = 8 + 187; // disc + V3 layout
  let o = 8;
  const readPk = () => {
    const pk = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return pk;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const readI64 = () => {
    const v = data.readBigInt64LE(o);
    o += 8;
    return v;
  };
  const readU8 = () => {
    const v = data[o];
    o += 1;
    return v;
  };

  const owner = readPk();
  const perpMarket = readPk();
  // V2 fields
  let collateralMint = PublicKey.default;
  let kaminoObligation = PublicKey.default;
  if (data.length >= V2_SIZE) {
    collateralMint = readPk();
    kaminoObligation = readPk();
  }
  const collateralAmount = readU64();
  const borrowAmountUsdc = readU64();
  const perpSide = readU8() as Side;
  const perpSize = readU64();
  const entryPrice = readU64();
  const openedAt = readI64();
  const hedgeAmount = data.length >= V2_SIZE ? readU64() : 0n;
  const isOpen = readU8() !== 0;
  const bump = readU8();

  // V3 field
  const collateralEntryPrice = data.length >= V3_SIZE ? readU64() : 0n;

  return {
    owner, perpMarket, collateralMint, kaminoObligation,
    collateralAmount, borrowAmountUsdc, perpSide, perpSize,
    entryPrice, openedAt, hedgeAmount, isOpen, bump,
    collateralEntryPrice,
  };
}

// ===== DFBA instruction builders =====

const COMMITMENT_SEED = Buffer.from("commitment");

export function findCommitmentPda(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([COMMITMENT_SEED, user.toBuffer()], ATOMIC_PERPS_PROGRAM_ID);
}

export function buildExecuteBatchIx(args: {
  cranker: PublicKey;
  pythPriceFeed: PublicKey;
  bidShards: PublicKey[];
  askShards: PublicKey[];
}): TransactionInstruction {
  const [config] = findConfigPda();
  const allShards = [...args.bidShards, ...args.askShards];
  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.cranker, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
      ...allShards.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true })),
    ],
    data: Buffer.concat([
      discriminator("execute_batch"),
      writeU8(args.bidShards.length),
    ]),
  });
}

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
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: args.queueShard, isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function buildCancelOrderIx(args: {
  user: PublicKey;
  queueShard: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: args.queueShard, isSigner: false, isWritable: true },
    ],
    data: discriminator("cancel_order"),
  });
}

// ----- update_config -----

const NO_CHANGE_U64 = BigInt("18446744073709551615"); // u64::MAX

export function buildUpdateConfigIx(args: {
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
  stressActive?: boolean;
}): TransactionInstruction {
  const [config] = findConfigPda();
  const NO_CHANGE_PK = PublicKey.default;

  const data = Buffer.concat([
    discriminator("update_config"),
    (args.newAuthority ?? NO_CHANGE_PK).toBuffer(),
    (args.newFeeRecipient ?? NO_CHANGE_PK).toBuffer(),
    writeU64LE(args.protocolFeeBps !== undefined ? BigInt(args.protocolFeeBps) : NO_CHANGE_U64),
    writeU64LE(args.maxLeverage !== undefined ? BigInt(args.maxLeverage) : NO_CHANGE_U64),
    writeU64LE(args.liquidationThreshold !== undefined ? BigInt(args.liquidationThreshold) : NO_CHANGE_U64),
    writeU64LE(args.maxTvl !== undefined ? args.maxTvl : NO_CHANGE_U64),
    writeU8(args.isPaused !== undefined ? (args.isPaused ? 1 : 0) : 255),
    writeU64LE(args.totalUsdcReserve !== undefined ? args.totalUsdcReserve : NO_CHANGE_U64),
    writeU64LE(args.psfBalance !== undefined ? args.psfBalance : NO_CHANGE_U64),
    // V3: stress_active byte (255 = no change)
    writeU8(args.stressActive !== undefined ? (args.stressActive ? 1 : 0) : 255),
  ]);

  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ----- migrate_config V3 -----

export function buildMigrateConfigV3Ix(args: {
  authority: PublicKey;
  jlpMint: PublicKey;
  jlpVault: PublicKey;
  msolMint: PublicKey;
  msolVault: PublicKey;
  pythMsolFeed: PublicKey;
}): TransactionInstruction {
  const [config] = findConfigPda();

  const data = Buffer.concat([
    discriminator("migrate_config"),
    writePubkey(args.jlpMint),
    writePubkey(args.jlpVault),
    writePubkey(args.msolMint),
    writePubkey(args.msolVault),
    writePubkey(args.pythMsolFeed),
  ]);

  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ----- init_queue_shard -----

const QUEUE_SEED = Buffer.from("queue");
const INIT_QUEUE_DISC: Buffer = Buffer.from([0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8]);

export function findQueueShardPda(market: number, side: number, shard: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [QUEUE_SEED, Buffer.from([market, side, shard])],
    ATOMIC_PERPS_PROGRAM_ID,
  );
}

export function buildInitQueueShardIx(args: {
  payer: PublicKey;
  market: number;
  side: number;
  shard: number;
}): TransactionInstruction {
  const [queueShard] = findQueueShardPda(args.market, args.side, args.shard);
  const data = Buffer.concat([
    INIT_QUEUE_DISC,
    Buffer.from([args.market, args.side, args.shard]),
  ]);
  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: queueShard, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
