import { FC } from "react";
import { HealthView } from "../hooks/usePosition";

export const CollateralHealth: FC<{ health: HealthView | null }> = ({ health }) => {
  if (!health) return null;

  const hf = Number(health.healthFactorBps) / 100; // bps → percent
  const color = hf >= 150 ? "bg-green-500" : hf >= 110 ? "bg-yellow-500" : "bg-red-500";
  const barWidth = Math.min(100, (hf / 200) * 100);

  return (
    <div className="border border-slate-800 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-sm text-slate-400">Health Factor</span>
        <span className="text-2xl font-mono">{hf.toFixed(1)}%</span>
      </div>
      <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${barWidth}%` }} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-slate-400">SOL price</dt>
        <dd className="text-right font-mono">${health.solPrice.toFixed(2)}</dd>
        <dt className="text-slate-400">Collateral value</dt>
        <dd className="text-right font-mono">
          ${(Number(health.collateralValueUsdc) / 1e6).toFixed(2)}
        </dd>
        <dt className="text-slate-400">Borrow</dt>
        <dd className="text-right font-mono">
          ${(Number(health.borrowValueUsdc) / 1e6).toFixed(2)}
        </dd>
        <dt className="text-slate-400">PnL</dt>
        <dd
          className={`text-right font-mono ${
            Number(health.pnlUsdc) >= 0 ? "text-green-400" : "text-red-400"
          }`}
        >
          ${(Number(health.pnlUsdc) / 1e6).toFixed(2)}
        </dd>
      </dl>
      {health.liquidatable && (
        <div className="mt-3 text-xs text-red-400 font-semibold">
          ⚠ LIQUIDATABLE — bots will close this position
        </div>
      )}
    </div>
  );
};
