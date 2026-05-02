import { FC } from "react";
import { HealthView } from "../hooks/usePosition";

const ZONE_COLORS = {
  safe: { bar: "bg-green-500", text: "text-green-400", label: "Safe" },
  zone1: { bar: "bg-yellow-500", text: "text-yellow-400", label: "DL 25%" },
  zone2: { bar: "bg-orange-500", text: "text-orange-400", label: "DL 50%" },
  zone3: { bar: "bg-red-500", text: "text-red-400", label: "DL 75%" },
  full: { bar: "bg-red-900", text: "text-red-300", label: "LIQUIDATION" },
};

export const CollateralHealth: FC<{ health: HealthView | null }> = ({ health }) => {
  if (!health) return null;

  const hf = Number(health.healthFactorBps) / 100; // bps → percent
  const zone = health.deleverageZone || (hf >= 5 ? "safe" : hf >= 4 ? "zone1" : hf >= 3 ? "zone2" : hf >= 2 ? "zone3" : "full");
  const zoneStyle = ZONE_COLORS[zone];
  const barWidth = Math.min(100, (hf / 15) * 100);

  return (
    <div className="border border-slate-800 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-sm text-slate-400">Health Factor</span>
        <div className="flex items-baseline gap-2">
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${zoneStyle.text} bg-slate-800`}>
            {zoneStyle.label}
          </span>
          <span className="text-2xl font-mono">{hf.toFixed(1)}%</span>
        </div>
      </div>
      {/* Zone-based health bar */}
      <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden relative">
        <div className={`h-full ${zoneStyle.bar} transition-all`} style={{ width: `${barWidth}%` }} />
        {/* Zone markers */}
        <div className="absolute top-0 left-0 w-full h-full flex" style={{ pointerEvents: "none" }}>
          <div style={{ width: "13.3%", borderRight: "1px solid #374151" }} title="2%" />
          <div style={{ width: "6.7%", borderRight: "1px solid #374151" }} title="3%" />
          <div style={{ width: "6.7%", borderRight: "1px solid #374151" }} title="4%" />
          <div style={{ width: "6.7%", borderRight: "1px solid #374151" }} title="5%" />
        </div>
      </div>
      <div className="flex justify-between text-[9px] text-slate-600 mt-1 px-0.5">
        <span>0%</span>
        <span>2%</span>
        <span>3%</span>
        <span>4%</span>
        <span>5%</span>
        <span>15%</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-slate-400">Mark price</dt>
        <dd className="text-right font-mono">${(health.markPrice ?? 0).toFixed(2)}</dd>
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
      {zone !== "safe" && (
        <div className={`mt-3 text-xs font-semibold ${zoneStyle.text}`}>
          {zone === "full"
            ? "LIQUIDATABLE — bots will close 100% of this position"
            : `Deleverage zone — bots will close ${health.deleveragePct ?? 25}% of this position`}
        </div>
      )}
    </div>
  );
};
