/**
 * Commit-Reveal scheme for large orders (>$10K notional).
 *
 * Per master-moves M-3 and limitations-handbook H-01:
 * - Commit: hash of order params in batch N
 * - Reveal: full order in batch N+1
 * - Eliminates last-millisecond batch sniping
 * - Small orders (<$10K) bypass commit-reveal entirely
 */

import { createHash, randomBytes } from "crypto";

const LARGE_ORDER_THRESHOLD_USD = 10_000; // $10K notional

export interface CommitData {
  user: string;
  price: string;    // 6dp string
  quantity: string;  // 6dp string
  side: "bid" | "ask";
  nonce: string;     // random 32 bytes hex
}

export interface Commitment {
  hash: string;
  side: "bid" | "ask";
  notionalEstimate: number;
  createdAt: number;
  batchSlot: number;
  revealed: boolean;
}

// In-memory store (production: Redis or on-chain PDA)
const pendingCommitments: Map<string, Commitment> = new Map();

/** Check if an order requires commit-reveal based on notional size. */
export function requiresCommitReveal(notionalUsd: number): boolean {
  return notionalUsd >= LARGE_ORDER_THRESHOLD_USD;
}

/** Generate a random nonce for the commitment. */
export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

/** Compute the commit hash from order parameters. */
export function computeCommitHash(data: CommitData): string {
  const payload = `${data.user}:${data.price}:${data.quantity}:${data.side}:${data.nonce}`;
  return createHash("sha256").update(payload).digest("hex");
}

/** Submit a commitment (commit phase). */
export function submitCommitment(
  user: string,
  hash: string,
  side: "bid" | "ask",
  notionalEstimate: number,
  batchSlot: number,
): void {
  pendingCommitments.set(`${user}:${hash}`, {
    hash,
    side,
    notionalEstimate,
    createdAt: Date.now(),
    batchSlot,
    revealed: false,
  });
}

/** Verify and reveal a committed order. Returns true if valid. */
export function verifyReveal(
  user: string,
  revealData: CommitData,
): boolean {
  const hash = computeCommitHash(revealData);
  const key = `${user}:${hash}`;
  const commitment = pendingCommitments.get(key);

  if (!commitment) return false;
  if (commitment.revealed) return false;
  if (commitment.side !== revealData.side) return false;

  // Mark as revealed
  commitment.revealed = true;
  pendingCommitments.set(key, commitment);
  return true;
}

/** Get all pending (unrevealed) commitments. */
export function getPendingCommitments(): Commitment[] {
  return [...pendingCommitments.values()].filter(c => !c.revealed);
}

/** Clean up expired commitments (older than 2 batch windows). */
export function cleanupExpired(maxAgeMs: number = 60_000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, c] of pendingCommitments) {
    if (c.createdAt < cutoff) pendingCommitments.delete(key);
  }
}
