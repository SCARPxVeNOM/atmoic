/**
 * Jupiter V6 swap integration.
 *
 * Fetches a swap route from Jupiter's quote API, then uses the
 * /swap-instructions endpoint to get a decomposed instruction
 * suitable for CPI passthrough in atomic_open.
 */

import { PublicKey } from "@solana/web3.js";
import pino from "pino";

const log = pino({ name: "jupiter" });

const JUPITER_API = "https://quote-api.jup.ag/v6";

export interface JupiterSwapBundle {
  swapIxData: Buffer;
  remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
}

/**
 * Build a Jupiter swap instruction for CPI passthrough.
 *
 * @param user       Wallet pubkey (payer/signer in the outer tx)
 * @param inputMint  Token to sell (e.g. USDC)
 * @param outputMint Token to buy (e.g. SOL wrapped)
 * @param amount     Amount of inputMint in native units
 * @param slippageBps Max slippage (default 50 = 0.5%)
 */
export async function buildJupiterSwap(
  user: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: bigint,
  slippageBps: number = 50,
): Promise<JupiterSwapBundle> {
  // Step 1: Get quote
  const quoteUrl = `${JUPITER_API}/quote?` +
    `inputMint=${inputMint.toBase58()}` +
    `&outputMint=${outputMint.toBase58()}` +
    `&amount=${amount.toString()}` +
    `&slippageBps=${slippageBps}` +
    `&onlyDirectRoutes=false`;

  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    const body = await quoteRes.text();
    throw new Error(`Jupiter quote failed: ${quoteRes.status} ${body}`);
  }
  const quoteResponse = await quoteRes.json();

  log.info({
    inAmount: quoteResponse.inAmount,
    outAmount: quoteResponse.outAmount,
    priceImpactPct: quoteResponse.priceImpactPct,
  }, "Jupiter quote received");

  // Step 2: Get swap instructions (decomposed, not serialized tx)
  const swapRes = await fetch(`${JUPITER_API}/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: user.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) {
    const body = await swapRes.text();
    throw new Error(`Jupiter swap-instructions failed: ${swapRes.status} ${body}`);
  }
  const swapData = await swapRes.json();

  // Step 3: Extract the main swap instruction
  const swapIx = swapData.swapInstruction;
  if (!swapIx) {
    throw new Error("Jupiter returned no swapInstruction");
  }

  // Convert to our format
  const programId = new PublicKey(swapIx.programId);
  const accounts = (swapIx.accounts as any[]).map((a: any) => ({
    pubkey: new PublicKey(a.pubkey),
    isSigner: a.isSigner,
    isWritable: a.isWritable,
  }));
  const ixData = Buffer.from(swapIx.data, "base64");

  // remaining_accounts: [jupiterProgram, ...accounts]
  const remainingAccounts = [
    { pubkey: programId, isSigner: false, isWritable: false },
    ...accounts,
  ];

  log.info({
    programId: programId.toBase58(),
    numAccounts: accounts.length,
    dataLen: ixData.length,
  }, "Jupiter swap instruction built");

  return {
    swapIxData: ixData,
    remainingAccounts,
  };
}
