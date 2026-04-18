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
  userSolAccount: PublicKey;
  userUsdcAccount: PublicKey;
  solVault: PublicKey;
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
  // Defaults to empty — set only when running against `kamino-cpi` builds.
  kaminoBorrowData?: Buffer;
  kaminoRemainingAccounts?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
}

export function buildAtomicOpenIx(args: AtomicOpenArgs): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.user);

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
  ]);

  const keys = [
    { pubkey: args.user, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
    { pubkey: args.userSolAccount, isSigner: false, isWritable: true },
    { pubkey: args.solVault, isSigner: false, isWritable: true },
    { pubkey: args.usdcReserve, isSigner: false, isWritable: true },
    { pubkey: args.userUsdcAccount, isSigner: false, isWritable: true },
    { pubkey: args.feeRecipientAccount, isSigner: false, isWritable: true },
    { pubkey: programAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...(args.kaminoRemainingAccounts ?? []),
    ...(args.jupiterRemainingAccounts ?? []),
  ];

  return new TransactionInstruction({ programId: ATOMIC_PERPS_PROGRAM_ID, keys, data });
}

export function buildAtomicCloseIx(args: {
  user: PublicKey;
  userSolAccount: PublicKey;
  userUsdcAccount: PublicKey;
  solVault: PublicKey;
  usdcReserve: PublicKey;
  feeRecipientAccount: PublicKey;
  pythPriceFeed: PublicKey;
  kaminoRepayData?: Buffer;
  kaminoRemainingAccounts?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
}): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.user);

  const data = Buffer.concat([
    discriminator("atomic_close"),
    writeVecU8(args.kaminoRepayData ?? Buffer.alloc(0)),
  ]);

  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
      { pubkey: args.userUsdcAccount, isSigner: false, isWritable: true },
      { pubkey: args.usdcReserve, isSigner: false, isWritable: true },
      { pubkey: args.solVault, isSigner: false, isWritable: true },
      { pubkey: args.userSolAccount, isSigner: false, isWritable: true },
      { pubkey: args.feeRecipientAccount, isSigner: false, isWritable: true },
      { pubkey: programAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...(args.kaminoRemainingAccounts ?? []),
    ],
    data,
  });
}

export function buildLiquidateIx(args: {
  liquidator: PublicKey;
  positionOwner: PublicKey;
  liquidatorSolAccount: PublicKey;
  solVault: PublicKey;
  feeRecipientSolAccount: PublicKey;
  pythPriceFeed: PublicKey;
}): TransactionInstruction {
  const [config] = findConfigPda();
  const [programAuthority] = findAuthorityPda();
  const [position] = findPositionPda(args.positionOwner);

  return new TransactionInstruction({
    programId: ATOMIC_PERPS_PROGRAM_ID,
    keys: [
      { pubkey: args.liquidator, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: args.pythPriceFeed, isSigner: false, isWritable: false },
      { pubkey: args.solVault, isSigner: false, isWritable: true },
      { pubkey: args.liquidatorSolAccount, isSigner: false, isWritable: true },
      { pubkey: args.feeRecipientSolAccount, isSigner: false, isWritable: true },
      { pubkey: programAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: discriminator("liquidate"),
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
}

export function decodeGlobalConfig(data: Buffer): GlobalConfigData {
  assertDisc(data, GLOBAL_CONFIG_DISC, "GlobalConfig");
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

  return {
    authority: readPk(),
    feeRecipient: readPk(),
    pythSolFeed: readPk(),
    solMint: readPk(),
    usdcMint: readPk(),
    solVault: readPk(),
    usdcReserve: readPk(),
    isPaused: readU8() !== 0,
    maxLeverage: readU64(),
    liquidationThreshold: readU64(),
    protocolFeeBps: readU64(),
    maxTvl: readU64(),
    totalUsdcBorrowed: readU64(),
    totalUsdcReserve: readU64(),
    bump: readU8(),
    programAuthorityBump: readU8(),
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
}

export function decodePosition(data: Buffer): PositionData {
  assertDisc(data, POSITION_DISC, "Position");
  const V2_SIZE = 8 + 179; // disc + new layout
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

  return {
    owner, perpMarket, collateralMint, kaminoObligation,
    collateralAmount, borrowAmountUsdc, perpSide, perpSize,
    entryPrice, openedAt, hedgeAmount, isOpen, bump,
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
