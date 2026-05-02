export type ErrorKind = "wallet" | "network" | "transaction" | "backend" | "unknown";

export interface AppError {
  kind: ErrorKind;
  title: string;
  message: string;
}

export function classifyError(e: unknown): AppError {
  const raw = e instanceof Error ? e.message : String(e);
  const lo = raw.toLowerCase();

  // Wallet / user rejection
  if (/user rejected|rejected the request|user denied/.test(lo)) {
    return { kind: "wallet", title: "Rejected", message: "You rejected the transaction in your wallet." };
  }
  if (/wallet not connected|connect wallet first/.test(lo)) {
    return { kind: "wallet", title: "Wallet", message: "Connect your wallet first." };
  }

  // Network / connectivity
  if (/failed to fetch|network error|econnrefused|etimedout|502|503|504/.test(lo)) {
    return { kind: "network", title: "Network Error", message: "Could not reach the server. Check your connection and try again." };
  }

  // Insufficient funds
  if (/insufficient funds|insufficient lamports/.test(lo)) {
    return { kind: "transaction", title: "Insufficient Funds", message: "Not enough SOL to cover this transaction and fees." };
  }

  // On-chain / simulation failures
  if (/simulation failed|blockhash not found|custom program error|0x[0-9a-f]/i.test(raw)) {
    return { kind: "transaction", title: "Transaction Failed", message: raw };
  }

  // Backend / API
  if (/transaction failed|build failed|api/.test(lo)) {
    return { kind: "backend", title: "Server Error", message: raw };
  }

  return { kind: "unknown", title: "Error", message: raw };
}
