import { FC } from "react";
import { useCollateralTypes, CollateralTypeInfo } from "../hooks/useCollateralTypes";

interface Props {
  selected: string;
  onSelect: (type: string) => void;
}

export const CollateralSelector: FC<Props> = ({ selected, onSelect }) => {
  const types = useCollateralTypes();

  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">Collateral Type</label>
      <div className="flex gap-1.5">
        {types.map((t: CollateralTypeInfo) => (
          <button
            key={t.type}
            onClick={() => t.enabled && onSelect(t.type)}
            disabled={!t.enabled}
            className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${
              selected === t.type
                ? "bg-indigo-600 text-white"
                : t.enabled
                ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
                : "bg-slate-900 text-slate-600 cursor-not-allowed"
            }`}
          >
            {t.label}
            {t.enabled && (
              <span className="block text-[10px] opacity-60">-{t.haircutPct}%</span>
            )}
            {!t.enabled && (
              <span className="block text-[10px] opacity-40">Soon</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};
