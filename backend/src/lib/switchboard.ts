/**
 * Switchboard SOL/USD oracle fallback.
 *
 * Reads the on-chain Switchboard aggregator account directly to get
 * a price when Pyth Hermes is unavailable or stale.
 */

import { PublicKey } from "@solana/web3.js";
import { connection } from "./connection";

// Switchboard SOL/USD aggregator on mainnet
const SW_SOL_USD = new PublicKey("GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR");

// Switchboard AggregatorAccountData layout offsets (v2):
// result: f64 at offset 216 (8 bytes, IEEE 754)
// latest_confirmed_round.round_open_timestamp: i64 at offset 296
const RESULT_OFFSET = 216;
const TIMESTAMP_OFFSET = 296;

export interface SwitchboardPrice {
  price6dp: bigint;
  publishTime: number;
}

export async function fetchSwitchboardPrice(): Promise<SwitchboardPrice> {
  const acct = await connection.getAccountInfo(SW_SOL_USD);
  if (!acct || acct.data.length < 304) {
    throw new Error("Switchboard SOL/USD account not found or too small");
  }

  const buf = acct.data;
  // Read IEEE 754 f64 LE at RESULT_OFFSET
  const price = buf.readDoubleLE(RESULT_OFFSET);
  if (price <= 0 || !Number.isFinite(price)) {
    throw new Error(`Invalid Switchboard price: ${price}`);
  }

  // Convert to 6dp integer
  const price6dp = BigInt(Math.round(price * 1e6));

  // Read timestamp
  const ts = Number(buf.readBigInt64LE(TIMESTAMP_OFFSET));

  return { price6dp, publishTime: ts };
}
