import { useState, useEffect } from "react";
import { API_BASE } from "../config";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  closeTime: number;
}

export function useCandles(pair: string, interval: string = "5m") {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Reset immediately so chart doesn't render stale data from previous pair
    setCandles(null);
    setError(null);

    const load = async () => {
      try {
        const r = await fetch(`${API_BASE}/candles/${pair}?interval=${interval}&limit=500`);
        if (!r.ok) throw new Error(`${r.status}`);
        const data: Candle[] = await r.json();
        if (!cancelled) {
          setCandles(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };

    load();
    const id = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [pair, interval]);

  return { candles, error };
}
