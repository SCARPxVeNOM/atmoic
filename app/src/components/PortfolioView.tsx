import { PositionView, HealthView } from "../hooks/usePosition";

export function PortfolioView({
  accent,
  solPrice,
  position,
  health,
}: {
  accent: string;
  solPrice?: number;
  position?: PositionView | null;
  health?: HealthView | null;
}) {
  const price = solPrice || 142.30;
  const hasPosition = position?.isOpen ?? false;

  const collSol = hasPosition ? Number(position!.collateralAmount) / 1e9 : 0;
  const borrowUsdc = hasPosition ? Number(position!.borrowAmountUsdc) / 1e6 : 0;
  const perpSizeSol = hasPosition ? Number(position!.perpSize) / 1e9 : 0;
  const entry = hasPosition ? Number(position!.entryPrice) / 1e6 : 0;
  const side = position?.perpSide === 0 ? "Long" : "Short";

  const totalValue = collSol * price;
  const pnl = hasPosition
    ? (price - entry) * perpSizeSol * (side === "Long" ? 1 : -1)
    : 0;
  const pnlPct = totalValue > 0 ? (pnl / totalValue) * 100 : 0;

  const healthBps = health ? Number(health.healthFactorBps) : 10000;
  const healthFactor = healthBps / 10000;
  const healthCol = healthFactor > 1.3 ? "#3fb68b" : healthFactor > 1.0 ? "#d29922" : "#ff5353";

  const marginUsed = borrowUsdc > 0 && totalValue > 0
    ? Math.round((borrowUsdc / (totalValue + borrowUsdc)) * 100)
    : 0;

  const liqDistance = hasPosition && entry > 0
    ? Math.abs(((price - entry) / entry) * 100 * (side === "Long" ? 1 : -1))
    : 0;

  const STATS = [
    { label: "Total Value", val: hasPosition ? `$${totalValue.toFixed(2)}` : "$0.00", sub: null, col: undefined },
    { label: "Unrealized PnL", val: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, sub: `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`, col: pnl >= 0 ? "#3fb68b" : "#ff5353" },
    { label: "Collateral", val: hasPosition ? `${collSol.toFixed(4)} SOL` : "—", sub: hasPosition ? `$${totalValue.toFixed(2)}` : null, col: undefined },
    { label: "Open Positions", val: hasPosition ? "1" : "0", sub: null, col: undefined },
  ];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 24, background: "#0d1117" }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: "#e6edf3", marginBottom: 20 }}>Portfolio Overview</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        {STATS.map(s => (
          <div key={s.label} style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</div>
            <div style={{ fontSize: 22, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: s.col || "#e6edf3" }}>{s.val}</div>
            {s.sub && <div style={{ fontSize: 12, color: s.col || "#8b949e", marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 14 }}>Collateral Breakdown</div>
          {([
            ["SOL", hasPosition ? "100%" : "0%", hasPosition ? 1 : 0],
            ["JLP", "0%", 0],
            ["mSOL", "0%", 0],
          ] as [string, string, number][]).map(([name, pct, frac]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, fontSize: 13 }}>
              <span style={{ color: "#8b949e", width: 36 }}>{name}</span>
              <div style={{ flex: 1, background: "#21262d", borderRadius: 3, height: 6 }}>
                <div style={{ width: `${frac * 100}%`, height: "100%", background: accent, borderRadius: 3 }} />
              </div>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3", width: 32, textAlign: "right" }}>{pct}</span>
            </div>
          ))}
        </div>

        <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginBottom: 14 }}>Risk Metrics</div>
          {([
            ["Health Factor", hasPosition ? healthFactor.toFixed(2) : "—", healthCol],
            ["Margin Used", hasPosition ? `${marginUsed}%` : "—", marginUsed > 75 ? "#d29922" : "#3fb68b"],
            ["Liq. Distance", hasPosition ? `${liqDistance.toFixed(1)}%` : "—", liqDistance > 15 ? "#3fb68b" : "#d29922"],
            ["Correlated Exp.", "0%/30% cap", "#8b949e"],
          ] as [string, string, string][]).map(([lbl, val, col]) => (
            <div key={lbl} style={{
              display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13,
              borderBottom: "1px solid #21262d",
            }}>
              <span style={{ color: "#8b949e" }}>{lbl}</span>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: col, fontWeight: 600 }}>{val}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
