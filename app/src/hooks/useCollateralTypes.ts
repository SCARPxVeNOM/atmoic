import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface CollateralTypeInfo {
  type: string;
  haircutPct: number;
  enabled: boolean;
  label: string;
}

const COLLATERAL_TYPES: CollateralTypeInfo[] = [
  { type: "SOL", haircutPct: 10, enabled: true, label: "SOL" },
  { type: "USDC", haircutPct: 0, enabled: true, label: "USDC" },
  { type: "mSOL", haircutPct: 18, enabled: false, label: "mSOL" },
  { type: "JLP", haircutPct: 25, enabled: false, label: "JLP" },
];

export function useCollateralTypes() {
  const [types] = useState(COLLATERAL_TYPES);
  // In production: fetch enabled types + caps from backend
  return types;
}
