import { FC } from "react";
import { useMode } from "../context/ModeContext";

export const ModeToggle: FC = () => {
  const { mode, setMode } = useMode();
  return (
    <div className="flex items-center gap-1 text-xs bg-slate-900 rounded-lg p-0.5">
      <button
        onClick={() => setMode("simple")}
        className={`px-2.5 py-1 rounded-md transition-colors ${
          mode === "simple" ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
        }`}
      >
        Simple
      </button>
      <button
        onClick={() => setMode("standard")}
        className={`px-2.5 py-1 rounded-md transition-colors ${
          mode === "standard" ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
        }`}
      >
        Standard
      </button>
      <button
        onClick={() => setMode("pro")}
        className={`px-2.5 py-1 rounded-md transition-colors ${
          mode === "pro" ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
        }`}
      >
        Pro
      </button>
    </div>
  );
};
