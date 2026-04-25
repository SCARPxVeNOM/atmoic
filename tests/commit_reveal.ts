/**
 * Commit-reveal tests.
 *
 * All tests are skipped — the commit-reveal instructions (place_commitment,
 * reveal_order) exist in source but are not wired into lib.rs/mod.rs
 * (deferred to Phase 2 per M-3).
 *
 * Build: anchor build --no-idl -- --features mock-oracle,dfba
 * Run:   anchor test --skip-build
 */

import { Connection, Keypair } from "@solana/web3.js";

describe("commit_reveal", () => {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");

  it.skip("places a commitment hash", async () => {
    // Expected: PDA created with hash stored, revealed=false
  });

  it.skip("reveals committed order", async () => {
    // Expected: Hash verified against reveal data, order placed in queue
  });

  it.skip("rejects wrong nonce (HashMismatch 6019)", async () => {
    // Expected: Error 6019 — nonce doesn't match committed hash
  });

  it.skip("rejects double reveal (CommitmentAlreadyRevealed 6018)", async () => {
    // Expected: Error 6018 — commitment already revealed
  });

  it.skip("rejects reveal without commitment (CommitmentNotFound 6017)", async () => {
    // Expected: Error 6017 — no commitment PDA exists for user
  });

  it.skip("rejects reveal into full queue (QueueFull 6016)", async () => {
    // Expected: Error 6016 — target queue shard at capacity (85 orders)
  });
});
