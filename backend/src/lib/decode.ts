import { PublicKey } from "@solana/web3.js";

export enum Side {
  Long = 0,
  Short = 1,
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
  // V2
  totalLongOi: bigint;
  totalShortOi: bigint;
  psfBalance: bigint;
  // V3
  jlpMint: PublicKey;
  jlpVault: PublicKey;
  msolMint: PublicKey;
  msolVault: PublicKey;
  pythMsolFeed: PublicKey;
  stressActive: boolean;
  totalCorrelatedCollateral: bigint;
  totalCollateral: bigint;
  // V4
  lastFundingAt: bigint;
  accumulatedFunding: bigint;
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
  collateralEntryPrice: bigint; // V3
  isOpen: boolean;
  bump: number;
}

class Reader {
  constructor(private buf: Buffer, public o: number = 8) {}
  pk(): PublicKey {
    const pk = new PublicKey(this.buf.subarray(this.o, this.o + 32));
    this.o += 32;
    return pk;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
  u8(): number {
    const v = this.buf[this.o];
    this.o += 1;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
}

export function decodeGlobalConfig(data: Buffer): GlobalConfigData {
  const r = new Reader(data);
  const V2_SIZE = 8 + 299;
  const V3_SIZE = 8 + 476;
  const V4_SIZE = 8 + 492;

  const base = {
    authority: r.pk(),
    feeRecipient: r.pk(),
    pythSolFeed: r.pk(),
    solMint: r.pk(),
    usdcMint: r.pk(),
    solVault: r.pk(),
    usdcReserve: r.pk(),
    isPaused: r.bool(),
    maxLeverage: r.u64(),
    liquidationThreshold: r.u64(),
    protocolFeeBps: r.u64(),
    maxTvl: r.u64(),
    totalUsdcBorrowed: r.u64(),
    totalUsdcReserve: r.u64(),
    bump: r.u8(),
    programAuthorityBump: r.u8(),
  };

  // V2 fields
  const v2 = data.length >= V2_SIZE
    ? { totalLongOi: r.u64(), totalShortOi: r.u64(), psfBalance: r.u64() }
    : { totalLongOi: 0n, totalShortOi: 0n, psfBalance: 0n };

  // V3 fields
  const v3 = data.length >= V3_SIZE
    ? {
        jlpMint: r.pk(), jlpVault: r.pk(),
        msolMint: r.pk(), msolVault: r.pk(),
        pythMsolFeed: r.pk(),
        stressActive: r.bool(),
        totalCorrelatedCollateral: r.u64(),
        totalCollateral: r.u64(),
      }
    : {
        jlpMint: PublicKey.default, jlpVault: PublicKey.default,
        msolMint: PublicKey.default, msolVault: PublicKey.default,
        pythMsolFeed: PublicKey.default,
        stressActive: false,
        totalCorrelatedCollateral: 0n,
        totalCollateral: 0n,
      };

  // V4 fields
  const v4 = data.length >= V4_SIZE
    ? { lastFundingAt: r.i64(), accumulatedFunding: r.i64() }
    : { lastFundingAt: 0n, accumulatedFunding: 0n };

  return { ...base, ...v2, ...v3, ...v4 };
}

export function decodePosition(data: Buffer): PositionData {
  const r = new Reader(data);
  const V2_SPACE = 8 + 179;
  const V3_SPACE = 8 + 187;
  const owner = r.pk();
  const perpMarket = r.pk();
  // V2 fields: collateral_mint + kamino_obligation (64 bytes) inserted here
  let collateralMint = PublicKey.default;
  let kaminoObligation = PublicKey.default;
  if (data.length >= V2_SPACE) {
    collateralMint = r.pk();
    kaminoObligation = r.pk();
  }
  const collateralAmount = r.u64();
  const borrowAmountUsdc = r.u64();
  const perpSide = r.u8() as Side;
  const perpSize = r.u64();
  const entryPrice = r.u64();
  const openedAt = r.i64();
  // V2 field: hedge_amount after opened_at
  const hedgeAmount = data.length >= V2_SPACE ? r.u64() : 0n;
  // V3 field: collateral_entry_price
  const collateralEntryPrice = data.length >= V3_SPACE ? r.u64() : 0n;
  const isOpen = r.bool();
  const bump = r.u8();
  return {
    owner, perpMarket, collateralMint, kaminoObligation,
    collateralAmount, borrowAmountUsdc, perpSide, perpSize,
    entryPrice, openedAt, hedgeAmount, collateralEntryPrice, isOpen, bump,
  };
}
