import { PublicKey } from "@solana/web3.js";
import { programId } from "./connection";

export const CONFIG_SEED = Buffer.from("config");
export const POSITION_SEED = Buffer.from("position");
export const AUTHORITY_SEED = Buffer.from("authority");

export function findConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

export function findAuthorityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AUTHORITY_SEED], programId);
}

export function findPositionPda(owner: PublicKey, marketFeed: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POSITION_SEED, owner.toBuffer(), marketFeed.toBuffer()], programId);
}
