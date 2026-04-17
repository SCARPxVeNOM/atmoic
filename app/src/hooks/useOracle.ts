import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface OraclePrice {
  price: number;
  confidence: number;
  publishTime: number;
}

/** Polls backend /price/sol (which proxies Hermes — free, no redistribution issue). */
export function useOracle(pollMs = 2000): OraclePrice | null {
  const [price, setPrice] = useState<OraclePrice | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE}/price/sol`);
        if (!r.ok) return;
        const json = (await r.json()) as OraclePrice;
        if (alive) setPrice(json);
      } catch {
        // ignore
      }
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);

  return price;
}
