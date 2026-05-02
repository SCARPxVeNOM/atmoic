import { PositionView, HealthView } from "../hooks/usePosition";
import { usePortfolioHealth, PortfolioHealth } from "../hooks/usePortfolioHealth";

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
  const portfolio = usePortfolioHealth();
  const price = solPrice || 0;
  const hasPosition = position?.isOpen ?? false;

  const collSol = hasPosition ? Number(position!.collateralAmount) / 1e9 : 0;
  const borrowUsdc = hasPosition ? Number(position!.borrowAmountUsdc) / 1e6 : 0;
  const entry = hasPosition ? Number(position!.entryPrice) / 1e6 : 0;
  const side = position?.perpSide === 0 ? "Long" : "Short";

  const totalValue = portfolio?.totalCollateralUsd ?? collSol * price;
  const pnl = hasPosition
    ? (price - entry) * (Number(position!.perpSize) / 1e6 / price) * (side === "Long" ? 1 : -1)
    : 0;
  const pnlPct = totalValue > 0 ? (pnl / totalValue) * 100 : 0;

  const posCount = portfolio?.positions?.length ?? (hasPosition ? 1 : 0);

  const STATS = [
    { label: "Total Value", val: `$${totalValue.toFixed(2)}`, sub: null, col: undefined },
    { label: "Unrealized PnL", val: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, sub: `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`, col: pnl >= 0 ? "#3fb68b" : "#ff5353" },
    { label: "Open Positions", val: String(posCount), sub: null, col: undefined },
    {
      label: "Margin Savings",
      val: portfolio ? `$${portfolio.savingsUsd.toFixed(2)}` : "$0.00",
      sub: portfolio && portfolio.savingsPct > 0 ? `${portfolio.savingsPct.toFixed(1)}% from hedging` : null,
      col: portfolio && portfolio.savingsPct > 0 ? "#3fb68b" : undefined,
    },
  ];

  const phBps = portfolio?.portfolioHealthBps ?? 10000;
  const phPct = Math.min(100, (phBps / 200)); // scale for bar
  const phCol = phBps > 1500 ? "#3fb68b" : phBps > 800 ? "#d29922" : "#ff5353";

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 24, background: "#000" }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: "#ffffff", marginBottom: 20 }}>Portfolio Overview</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, marginBottom: 1, background: "#1a1a1f" }}>
        {STATS.map(s => (
          <div key={s.label} style={{ background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 0, padding: 16 }}>
            <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</div>
            <div style={{ fontSize: 22, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: s.col || "#ffffff" }}>{s.val}</div>
            {s.sub && <div style={{ fontSize: 12, color: s.col || "#8b949e", marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Portfolio Health Bar */}
      {portfolio && posCount > 0 && (
        <div style={{ background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 0, padding: 16, marginBottom: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ffffff" }}>Portfolio Health</span>
            <span style={{ fontSize: 20, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: phCol }}>
              {(phBps / 100).toFixed(1)}%
            </span>
          </div>
          <div style={{ width: "100%", height: 6, background: "#1a1a1f", borderRadius: 0, overflow: "hidden" }}>
            <div style={{ width: `${phPct}%`, height: "100%", background: phCol, borderRadius: 0, transition: "all 0.3s" }} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1, marginTop: 14, background: "#1a1a1f" }}>
            <div style={{ background: "#0a0a0b", padding: "10px 0" }}>
              <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase" }}>Portfolio Margin</div>
              <div style={{ fontSize: 14, fontFamily: "IBM Plex Mono,monospace", color: "#ffffff", marginTop: 2 }}>
                ${portfolio.portfolioMarginUsd.toFixed(2)}
              </div>
            </div>
            <div style={{ background: "#0a0a0b", padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase" }}>Individual Sum</div>
              <div style={{ fontSize: 14, fontFamily: "IBM Plex Mono,monospace", color: "#8b949e", marginTop: 2 }}>
                ${portfolio.individualMarginUsd.toFixed(2)}
              </div>
            </div>
            <div style={{ background: "#0a0a0b", padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase" }}>Worst Scenario</div>
              <div style={{ fontSize: 11, fontFamily: "IBM Plex Mono,monospace", color: "#d29922", marginTop: 4 }}>
                {portfolio.worstScenario}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: portfolio && portfolio.correlationMatrix.markets.length > 1 ? "1fr 1fr" : "1fr", gap: 1, background: "#1a1a1f" }}>
        {/* Correlation Matrix */}
        {portfolio && portfolio.correlationMatrix.markets.length > 1 && (
          <div style={{ background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 0, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", marginBottom: 14 }}>Correlation Matrix</div>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ padding: 4 }} />
                  {portfolio.correlationMatrix.markets.map(m => (
                    <th key={m} style={{ padding: 4, color: "#8b949e", fontWeight: 600 }}>{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {portfolio.correlationMatrix.markets.map((m, i) => (
                  <tr key={m}>
                    <td style={{ padding: 4, color: "#8b949e", fontWeight: 600 }}>{m}</td>
                    {portfolio.correlationMatrix.values[i].map((v, j) => (
                      <td key={j} style={{
                        padding: 4, textAlign: "center",
                        fontFamily: "IBM Plex Mono,monospace",
                        color: v >= 0.8 ? "#3fb68b" : v >= 0.6 ? "#d29922" : "#8b949e",
                      }}>
                        {v.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Collateral Breakdown */}
        <div style={{ background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 0, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", marginBottom: 14 }}>Collateral Breakdown</div>
          {([
            ["SOL", hasPosition ? "100%" : "0%", hasPosition ? 1 : 0],
            ["JLP", "0%", 0],
            ["mSOL", "0%", 0],
          ] as [string, string, number][]).map(([name, pct, frac]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, fontSize: 13 }}>
              <span style={{ color: "#8b949e", width: 36 }}>{name}</span>
              <div style={{ flex: 1, background: "#1a1a1f", borderRadius: 0, height: 6 }}>
                <div style={{ width: `${frac * 100}%`, height: "100%", background: accent, borderRadius: 0 }} />
              </div>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#ffffff", width: 32, textAlign: "right" }}>{pct}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
