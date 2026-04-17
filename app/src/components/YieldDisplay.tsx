import { FC, useEffect, useState } from "react";
import { API_BASE } from "../config";

interface Props {
  collateralAmount?: string;
  solPrice: number;
  collateralType?: string;
}

interface YieldRates {
  SOL: number;
  mSOL: number;
  JLP: number;
}

export const YieldDisplay: FC<Props> = ({
  collateralAmount,
  solPrice,
  collateralType = "SOL",
}) => {
  const [rates, setRates] = useState<YieldRates>({ SOL: 0, mSOL: 0, JLP: 0 });

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/yield/sol`);
        if (!r.ok) return;
        const d = await r.json();
        if (live) {
          setRates({
            SOL: d.apy ?? 0.045,    // Kamino SOL staking ~4.5%
            mSOL: 0.072,            // Marinade mSOL staking ~7.2%
            JLP: 0.24,              // Jupiter LP ~24%
          });
        }
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const collateralSol = collateralAmount ? Number(collateralAmount) / 1e9 : 0;
  const collateralUsd = collateralSol * solPrice;
  const activeRate = rates[collateralType as keyof YieldRates] ?? rates.SOL;
  const dailyYield = collateralUsd * (activeRate / 365);
  const weeklyYield = dailyYield * 7;

  if (collateralSol === 0 && activeRate === 0) return null;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-400">Collateral Yield</span>
        <span className="text-sm font-mono text-green-400">
          {(activeRate * 100).toFixed(2)}% APY
        </span>
      </div>

      {/* Yield breakdown by type */}
      <div className="grid grid-cols-3 gap-1 text-[10px]">
        {(["SOL", "mSOL", "JLP"] as const).map(type => (
          <div
            key={type}
            className={`rounded px-1.5 py-1 text-center ${
              collateralType === type
                ? "bg-green-900/30 text-green-400"
                : "bg-slate-800/50 text-slate-600"
            }`}
          >
            <div className="font-medium">{type}</div>
            <div>{(rates[type] * 100).toFixed(1)}%</div>
          </div>
        ))}
      </div>

      {collateralSol > 0 && (
        <div className="text-xs text-slate-500 space-y-0.5">
          <div>
            ~${dailyYield.toFixed(4)}/day &middot; ~${weeklyYield.toFixed(3)}/week
          </div>
          <div className="text-slate-600">
            On {collateralSol.toFixed(4)} {collateralType} (${collateralUsd.toFixed(2)})
            {collateralType === "SOL" && " via Kamino Klend"}
            {collateralType === "mSOL" && " via Marinade"}
            {collateralType === "JLP" && " via Jupiter LP"}
          </div>
        </div>
      )}
    </div>
  );
};
