import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface YieldInfo {
  collateralType: string;
  currentApy: number;
  rate8h: number;
  rate8hBps: number;
}

export function useYield(collateralType: string = "SOL", pollMs = 30000): YieldInfo | null {
  const [info, setInfo] = useState<YieldInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`${API_BASE}/yield/${collateralType}`);
        if (!alive) return;
        if (res.ok) {
          setInfo(await res.json());
        }
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [collateralType, pollMs]);

  return info;
}
