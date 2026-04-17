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
  return {
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
}

export function decodePosition(data: Buffer): PositionData {
  const r = new Reader(data);
  const V1_SPACE = 8 + 107; // disc + original fields
  const V2_SPACE = 8 + 179; // disc + new fields
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
  const isOpen = r.bool();
  const bump = r.u8();
  return {
    owner, perpMarket, collateralMint, kaminoObligation,
    collateralAmount, borrowAmountUsdc, perpSide, perpSize,
    entryPrice, openedAt, hedgeAmount, isOpen, bump,
  };
}
