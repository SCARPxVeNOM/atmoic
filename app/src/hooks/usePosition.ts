import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { API_BASE } from "../config";

export interface PositionView {
  owner: string;
  perpMarket: string;
  collateralMint: string;
  collateralAmount: string;
  borrowAmountUsdc: string;
  perpSide: number;
  perpSize: string;
  entryPrice: string;
  openedAt: string;
  /** Power parameter: 0|1000=standard, 2000=squeeth. Formerly hedgeAmount. */
  powerMilli: number;
  collateralEntryPrice: string;
  isOpen: boolean;
}

export type DeleverageZone = "safe" | "zone1" | "zone2" | "zone3" | "full";

export interface HealthView {
  markPrice: number;
  market: string;
  collateralValueUsdc: string;
  borrowValueUsdc: string;
  pnlUsdc: string;
  healthFactorBps: string;
  liquidatable: boolean;
  deleverageZone?: DeleverageZone;
  deleveragePct?: number;
}

/** Fetch all open positions for the connected wallet. */
export function usePositions(defaultPollMs = 5000) {
  const { publicKey } = useWallet();
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pollMs = useRef(defaultPollMs);

  const startConfirming = useCallback(() => {
    setConfirming(true);
    pollMs.current = 2000;
  }, []);

  const stopConfirming = useCallback(() => {
    setConfirming(false);
    pollMs.current = defaultPollMs;
  }, [defaultPollMs]);

  useEffect(() => {
    if (!publicKey) {
      setPositions([]);
      return;
    }
    let alive = true;
    const tick = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/positions/${publicKey.toBase58()}`);
        if (!alive) return;
        if (res.ok) {
          const data = await res.json();
          setPositions(Array.isArray(data) ? data : []);
        } else {
          setPositions([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    tick();
    const id = setInterval(tick, pollMs.current);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [publicKey, confirming]);

  return { positions, loading, confirming, startConfirming, stopConfirming };
}

/** Legacy single-position hook for backward compat. Returns first open position. */
export function usePosition(defaultPollMs = 5000) {
  const { positions, loading, confirming, startConfirming, stopConfirming } = usePositions(defaultPollMs);
  const position = positions.length > 0 ? positions[0] : null;
  return { position, health: null as HealthView | null, loading, confirming, startConfirming, stopConfirming };
}
