import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface MarketInfo {
  symbol: string;
  name: string;
  maxLeverage: number;
  enabled: boolean;
  category: string;
}

export function useMarkets() {
  const [markets, setMarkets] = useState<MarketInfo[]>([
    { symbol: "SOL-PERP", name: "Solana", maxLeverage: 10000, enabled: true, category: "major" },
    { symbol: "BTC-PERP", name: "Bitcoin", maxLeverage: 20000, enabled: false, category: "major" },
    { symbol: "ETH-PERP", name: "Ethereum", maxLeverage: 20000, enabled: false, category: "major" },
  ]);

  useEffect(() => {
    fetch(`${API_BASE}/markets`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setMarkets(data); })
      .catch(() => {});
  }, []);

  return markets;
}
