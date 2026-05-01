import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { API_BASE } from "../config";

export interface TradeRecord {
  wallet: string;
  market: string;
  side: "Long" | "Short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  collateralType: string;
  closeBps: number;
  closedAt: number;
  txSig?: string;
}

export function useTradeHistory(pollMs = 10000) {
  const { publicKey } = useWallet();
  const [trades, setTrades] = useState<TradeRecord[]>([]);

  useEffect(() => {
    if (!publicKey) {
      setTrades([]);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`${API_BASE}/trades/${publicKey.toBase58()}`);
        if (res.ok && alive) {
          setTrades(await res.json());
        }
      } catch { /* endpoint not ready */ }
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [publicKey, pollMs]);

  return trades;
}
