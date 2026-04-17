/**
 * Privy Provider — adds email/social login + session keys.
 * Falls back gracefully if Privy app ID is not configured or SDK not installed.
 */

import { ReactNode, lazy, Suspense } from "react";
import { PRIVY_APP_ID } from "../config";

// Lazy-load Privy to avoid hard dependency. If @privy-io/react-auth
// is not installed, the app still works with standard wallet signing.
let PrivyInner: any = null;

try {
  // @ts-ignore — optional dependency
  const mod = require("@privy-io/react-auth");
  PrivyInner = mod.PrivyProvider;
} catch {
  // Privy not installed — that's fine
}

export function PrivyAuthProvider({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID || !PrivyInner) {
    return <>{children}</>;
  }

  const Provider = PrivyInner;
  return (
    <Provider
      appId={PRIVY_APP_ID}
      config={{
        appearance: { theme: "dark", accentColor: "#6366f1" },
        loginMethods: ["email", "wallet"],
        embeddedWallets: { createOnLogin: "users-without-wallets" },
      }}
    >
      {children}
    </Provider>
  );
}
