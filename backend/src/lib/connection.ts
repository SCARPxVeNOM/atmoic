import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { env } from "./env";

export const connection = new Connection(env.rpcUrl, {
  commitment: "confirmed",
  wsEndpoint: env.wsUrl,
});

export function loadKeypair(pathOrInline: string = env.liquidatorKeypairPath): Keypair {
  const raw = fs.readFileSync(pathOrInline, "utf8").trim();
  const parsed = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export const programId = new PublicKey(env.programId);
