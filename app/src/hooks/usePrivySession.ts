/**
 * Session key hook for gasless one-click trading via Privy.
 *
 * When Privy is configured (VITE_PRIVY_APP_ID set):
 * - Exposes Privy login state and embedded wallet
 * - Tracks session spending cap for auto-signing
 * - Falls back gracefully when Privy is unavailable
 *
 * When Privy is NOT configured:
 * - Returns enabled=false, app uses standard Phantom wallet signing
 */

import { useState, useCallback, useMemo } from "react";
import { PRIVY_APP_ID } from "../config";

// Dynamically import Privy hooks — graceful fallback if not installed
let usePrivyHook: any = null;
let useWalletsHook: any = null;
try {
  // @ts-ignore — optional dependency
  const mod = require("@privy-io/react-auth");
  usePrivyHook = mod.usePrivy;
  useWalletsHook = mod.useWallets;
} catch {
  // Privy SDK not installed — that's fine
}

interface SessionState {
  active: boolean;
  spendingCapSol: number;
  spentSol: number;
}

export function usePrivySession() {
  const enabled = !!PRIVY_APP_ID && !!usePrivyHook;

  // Call hooks unconditionally (React rules), but results are null when disabled
  const privy = enabled ? usePrivyHook() : null;
  const walletsResult = enabled ? useWalletsHook() : null;

  const [session, setSession] = useState<SessionState | null>(null);

  const user = privy?.user ?? null;
  const authenticated = privy?.authenticated ?? false;
  const login = privy?.login ?? (() => {});
  const logout = privy?.logout ?? (() => {});

  // Find the user's Solana embedded wallet if it exists
  const embeddedWallet = useMemo(() => {
    if (!walletsResult?.wallets) return null;
    return walletsResult.wallets.find(
      (w: any) => w.walletClientType === "privy" && w.chainType === "solana"
    ) ?? null;
  }, [walletsResult?.wallets]);

  const startSession = useCallback(async (spendingCapSol: number = 1.0) => {
    if (!enabled || !authenticated) return;
    setSession({
      active: true,
      spendingCapSol,
      spentSol: 0,
    });
  }, [enabled, authenticated]);

  const endSession = useCallback(() => {
    setSession(null);
  }, []);

  const recordSpend = useCallback((solAmount: number) => {
    setSession(prev => {
      if (!prev) return null;
      const newSpent = prev.spentSol + solAmount;
      if (newSpent >= prev.spendingCapSol) {
        return null; // Session exhausted
      }
      return { ...prev, spentSol: newSpent };
    });
  }, []);

  return {
    enabled,
    authenticated,
    user,
    embeddedWallet,
    login,
    logout,
    session,
    startSession,
    endSession,
    recordSpend,
    needsFullSign: !session?.active,
    remainingCap: session ? session.spendingCapSol - session.spentSol : 0,
  };
}
