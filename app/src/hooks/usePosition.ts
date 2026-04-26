import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { API_BASE } from "../config";

export interface PositionView {
  owner: string;
  collateralAmount: string;
  borrowAmountUsdc: string;
  perpSide: number;
  perpSize: string;
  entryPrice: string;
  hedgeAmount: string;
  isOpen: boolean;
}

export interface HealthView {
  solPrice: number;
  collateralValueUsdc: string;
  borrowValueUsdc: string;
  pnlUsdc: string;
  healthFactorBps: string;
  liquidatable: boolean;
}

export function usePosition(defaultPollMs = 5000) {
  const { publicKey } = useWallet();
  const [position, setPosition] = useState<PositionView | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pollMs = useRef(defaultPollMs);

  /** Speed up polling temporarily (e.g. while awaiting confirmation). */
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
      setPosition(null);
      setHealth(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      setLoading(true);
      try {
        const [pRes, hRes] = await Promise.all([
          fetch(`${API_BASE}/position/${publicKey.toBase58()}`),
          fetch(`${API_BASE}/position/${publicKey.toBase58()}/health`),
        ]);
        if (!alive) return;
        setPosition(pRes.ok ? await pRes.json() : null);
        setHealth(hRes.ok ? await hRes.json() : null);
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

  return { position, health, loading, confirming, startConfirming, stopConfirming };
}
