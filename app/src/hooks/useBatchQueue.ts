import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface BatchQueueView {
  bids: number;
  asks: number;
  bidOrders: { price: number; size: number }[];
  askOrders: { price: number; size: number }[];
  lastBatchAt: number;
  clearingPrice: number;
  totalVolume: number;
  oraclePrice: number;
}

export function useBatchQueue(pollMs = 2000) {
  const [queue, setQueue] = useState<BatchQueueView | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE}/batch/status`);
        if (r.ok && alive) setQueue(await r.json());
      } catch { /* endpoint not available yet */ }
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [pollMs]);

  return queue;
}
