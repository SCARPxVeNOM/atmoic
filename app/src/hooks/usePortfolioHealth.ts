import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { API_BASE } from "../config";

export interface PortfolioHealth {
  portfolioMarginUsd: number;
  individualMarginUsd: number;
  savingsUsd: number;
  savingsPct: number;
  worstScenario: string;
  portfolioHealthBps: number;
  totalCollateralUsd: number;
  positions: {
    market: string;
    side: string;
    notionalUsd: number;
    individualMarginUsd: number;
    portfolioContribution: number;
  }[];
  correlationMatrix: {
    markets: string[];
    values: number[][];
  };
}

export function usePortfolioHealth(pollMs = 5000): PortfolioHealth | null {
  const { publicKey } = useWallet();
  const [health, setHealth] = useState<PortfolioHealth | null>(null);

  useEffect(() => {
    if (!publicKey) {
      setHealth(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`${API_BASE}/portfolio/${publicKey.toBase58()}/health`);
        if (!alive) return;
        if (res.ok) {
          setHealth(await res.json());
        }
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [publicKey, pollMs]);

  return health;
}
