import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface OraclePrice {
  price: number;
  confidence: number;
  publishTime: number;
}

/** Polls backend /price/:market (which proxies Hermes — free, no redistribution issue). */
export function useOracle(market: string = "sol", pollMs = 2000): OraclePrice | null {
  const [price, setPrice] = useState<OraclePrice | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE}/price/${market}`);
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
  }, [market, pollMs]);

  return price;
}

/** Fetch oracle prices for multiple markets at once. */
export function useOraclePrices(markets: string[] = ["sol", "btc", "eth"], pollMs = 2000): Record<string, number> {
  const [prices, setPrices] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const results = await Promise.all(
          markets.map(async (m) => {
            const r = await fetch(`${API_BASE}/price/${m}`);
            if (!r.ok) return { market: m, price: 0 };
            const json = await r.json();
            return { market: m, price: json.price as number };
          })
        );
        if (!alive) return;
        const map: Record<string, number> = {};
        for (const { market, price } of results) {
          map[market] = price;
        }
        setPrices(map);
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
  }, [markets.join(","), pollMs]);

  return prices;
}
