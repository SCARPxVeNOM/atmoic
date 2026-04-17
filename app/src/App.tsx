import { FC } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useOracle } from "./hooks/useOracle";
import { usePosition } from "./hooks/usePosition";
import { usePrivySession } from "./hooks/usePrivySession";
import { PositionPanel } from "./components/PositionPanel";
import { SimplePanel } from "./components/SimplePanel";
import { ProPanel } from "./components/ProPanel";
import { CollateralHealth } from "./components/CollateralHealth";
import { YieldDisplay } from "./components/YieldDisplay";
import { ModeToggle } from "./components/ModeToggle";
import { ModeProvider, useMode } from "./context/ModeContext";

const Dashboard: FC = () => {
  const oracle = useOracle();
  const { position, health, startConfirming, stopConfirming } = usePosition();
  const { mode } = useMode();
  const privy = usePrivySession();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Atomic Perps</h1>
          <p className="text-xs text-slate-500">
            {mode === "simple"
              ? "Trade SOL with leverage — one click."
              : "Borrow, perp, hedge — one transaction, all-or-nothing."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ModeToggle />
          {oracle && (
            <div className="text-xs text-slate-400 font-mono">
              SOL ${oracle.price.toFixed(2)}
            </div>
          )}
          {privy.enabled && !privy.authenticated && (
            <button
              onClick={privy.login}
              className="px-3 py-1.5 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              Login with Email
            </button>
          )}
          {privy.enabled && privy.authenticated && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">
                {privy.user?.email?.address ?? "Connected"}
              </span>
              <button
                onClick={privy.logout}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                Sign out
              </button>
            </div>
          )}
          <WalletMultiButton />
        </div>
      </header>

      <main className="flex-1 max-w-xl mx-auto w-full px-6 py-8 space-y-4">
        {mode === "simple" ? (
          <SimplePanel position={position} solPrice={oracle?.price ?? 0} />
        ) : mode === "pro" ? (
          <ProPanel
            position={position}
            solPrice={oracle?.price ?? 0}
            onConfirming={startConfirming}
            onConfirmed={stopConfirming}
          />
        ) : (
          <PositionPanel
            position={position}
            solPrice={oracle?.price ?? 0}
            onConfirming={startConfirming}
            onConfirmed={stopConfirming}
          />
        )}
        <CollateralHealth health={health} />
        <YieldDisplay
          collateralAmount={position?.collateralAmount}
          solPrice={oracle?.price ?? 0}
        />
      </main>
    </div>
  );
};

export const App: FC = () => (
  <ModeProvider>
    <Dashboard />
  </ModeProvider>
);
