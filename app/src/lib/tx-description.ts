/**
 * Human-readable transaction descriptions for Phantom wallet preview
 * and the in-app confirmation modal.
 */

export interface TxDescriptionParams {
  type: "open" | "close";
  side?: "Long" | "Short";
  collateralSol?: number;
  leverage?: number;
  borrowUsdc?: number;
  solPrice?: number;
}

export function describeTransaction(params: TxDescriptionParams): string {
  if (params.type === "open") {
    const side = params.side ?? "Long";
    const lev = params.leverage ?? 2;
    const col = params.collateralSol ?? 0;
    const borrow = params.borrowUsdc ?? (col * (params.solPrice ?? 0) * (lev - 1));
    return `Open ${lev}x SOL ${side} \u2014 Deposit ${col} SOL, Borrow $${borrow.toFixed(2)} USDC via Kamino`;
  }

  if (params.type === "close") {
    const borrow = params.borrowUsdc ?? 0;
    const col = params.collateralSol ?? 0;
    return `Close SOL position \u2014 Repay $${borrow.toFixed(2)} USDC, Return ${col.toFixed(4)} SOL collateral`;
  }

  return "Unknown transaction";
}
