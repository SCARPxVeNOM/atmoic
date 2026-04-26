import { useState, useEffect } from "react";
import { API_BASE } from "../config";

export interface Ticker {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

export function useTickers() {
  const [tickers, setTickers] = useState<Record<string, Ticker> | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch(`${API_BASE}/tickers`);
        if (!r.ok) return;
        setTickers(await r.json());
      } catch {}
    };
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  return tickers;
}
