import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface FundingView {
  rate: number;      // annualized %
  rate8h: number;    // 8h rate %
  twapPrice: number; // 8h TWAP price
  nextUpdate: number;
}

export function useFundingRate(pollMs = 30000) {
  const [funding, setFunding] = useState<FundingView | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE}/funding/sol`);
        if (r.ok && alive) setFunding(await r.json());
      } catch { /* endpoint not available yet */ }
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [pollMs]);

  return funding;
}
