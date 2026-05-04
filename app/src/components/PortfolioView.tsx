import { PositionView } from "../hooks/usePosition";
import { usePortfolioHealth, PortfolioHealth } from "../hooks/usePortfolioHealth";
import { useIsMobile } from "../hooks/useIsMobile";

const JLP_MINT = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

function resolveCollateralLabel(mint: string): "SOL" | "JLP" | "mSOL" {
  if (mint === JLP_MINT) return "JLP";
  if (mint === MSOL_MINT) return "mSOL";
  return "SOL";
}

export function PortfolioView({
  accent,
  solPrice,
  positions,
  prices,
}: {
  accent: string;
  solPrice?: number;
  positions: PositionView[];
  prices?: Record<string, number>;
}) {
  const portfolio = usePortfolioHealth();
  const isMobile = useIsMobile();
  const price = solPrice || 0;

  const openPositions = positions.filter((p) => p.isOpen);
  const hasPositions = openPositions.length > 0;

  // Compute total collateral value across all open positions
  let totalValue = 0;
  let totalPnl = 0;
  const collBreakdown: Record<string, number> = { SOL: 0, JLP: 0, mSOL: 0 };

  for (const pos of openPositions) {
    const collSol = Number(pos.collateralAmount) / 1e9;
    const entry = Number(pos.entryPrice) / 1e6;
    const side = pos.perpSide === 0 ? 1 : -1;
    const perpSize = Number(pos.perpSize) / 1e6;

    const posCollValue = collSol * price;
    totalValue += posCollValue;

    if (entry > 0 && perpSize > 0) {
      const power = pos.powerMilli === 0 || pos.powerMilli === 1000 ? 1 : pos.powerMilli / 1000;
      let priceDelta: number;
      if (power === 2) {
        priceDelta = (price * price - entry * entry) / (entry * entry);
      } else {
        priceDelta = (price - entry) / entry;
      }
      totalPnl += priceDelta * (perpSize / price) * side;
    }

    const collType = resolveCollateralLabel(pos.collateralMint);
    collBreakdown[collType] += posCollValue;
  }

  // Use portfolio hook values if available
  if (portfolio?.totalCollateralUsd) totalValue = portfolio.totalCollateralUsd;
  const pnlPct = totalValue > 0 ? (totalPnl / totalValue) * 100 : 0;

  const STATS = [
    { label: "Total Value", val: `$${totalValue.toFixed(2)}`, sub: null, col: undefined },
    { label: "Unrealized PnL", val: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`, sub: `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`, col: totalPnl >= 0 ? "#3fb68b" : "#ff5353" },
    { label: "Open Positions", val: String(openPositions.length), sub: null, col: undefined },
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

  // Collateral breakdown percentages
  const collTotal = collBreakdown.SOL + collBreakdown.JLP + collBreakdown.mSOL;
  const collItems: [string, string, number][] = [
    ["SOL", collTotal > 0 ? `${((collBreakdown.SOL / collTotal) * 100).toFixed(0)}%` : "0%", collTotal > 0 ? collBreakdown.SOL / collTotal : 0],
    ["JLP", collTotal > 0 ? `${((collBreakdown.JLP / collTotal) * 100).toFixed(0)}%` : "0%", collTotal > 0 ? collBreakdown.JLP / collTotal : 0],
    ["mSOL", collTotal > 0 ? `${((collBreakdown.mSOL / collTotal) * 100).toFixed(0)}%` : "0%", collTotal > 0 ? collBreakdown.mSOL / collTotal : 0],
  ];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? 12 : 24, background: "#000" }}>
      <h2 style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, color: "#ffffff", marginBottom: isMobile ? 12 : 20 }}>Portfolio Overview</h2>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 1, marginBottom: 1, background: "#1a1a1f" }}>
        {STATS.map(s => (
          <div key={s.label} style={{ background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 0, padding: isMobile ? 10 : 16 }}>
            <div style={{ fontSize: isMobile ? 10 : 11, color: "#8b949e", marginBottom: isMobile ? 4 : 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</div>
            <div style={{ fontSize: isMobile ? 16 : 22, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: s.col || "#ffffff" }}>{s.val}</div>
            {s.sub && <div style={{ fontSize: isMobile ? 10 : 12, color: s.col || "#8b949e", marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Portfolio Health Bar */}
      {portfolio && hasPositions && (
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

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 1, marginTop: 14, background: "#1a1a1f" }}>
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

      <div style={{ display: "grid", gridTemplateColumns: !isMobile && portfolio && portfolio.correlationMatrix.markets.length > 1 ? "1fr 1fr" : "1fr", gap: 1, background: "#1a1a1f" }}>
        {/* Correlation Matrix — always show with real static values */}
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

        {/* Collateral Breakdown — computed from actual positions */}
        <div style={{ background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 0, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", marginBottom: 14 }}>Collateral Breakdown</div>
          {collItems.map(([name, pct, frac]) => (
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

      {/* Per-position breakdown */}
      {hasPositions && (
        <div style={{ background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 0, padding: 16, marginTop: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", marginBottom: 14 }}>Position Details</div>
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #1a1a1f" }}>
                {["Market", "Side", "Collateral", "Size", "Entry", "Power"].map(h => (
                  <th key={h} style={{ padding: "6px 8px", color: "#8b949e", fontWeight: 600, textAlign: "left", textTransform: "uppercase", fontSize: 10 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {openPositions.map((pos, i) => {
                const collType = resolveCollateralLabel(pos.collateralMint);
                const collAmt = (Number(pos.collateralAmount) / 1e9).toFixed(4);
                const size = (Number(pos.perpSize) / 1e6).toFixed(2);
                const entry = (Number(pos.entryPrice) / 1e6).toFixed(2);
                const sideLabel = pos.perpSide === 0 ? "Long" : "Short";
                const sideCol = pos.perpSide === 0 ? "#3fb68b" : "#ff5353";
                const isPower = pos.powerMilli === 2000;
                // Derive market label from perpMarket pubkey
                const FEED_LABELS: Record<string, string> = {
                  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": "SOL-PERP",
                  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": "BTC-PERP",
                  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": "ETH-PERP",
                };
                const market = FEED_LABELS[pos.perpMarket] ?? pos.perpMarket.slice(0, 8);
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #1a1a1f" }}>
                    <td style={{ padding: "8px", fontFamily: "IBM Plex Mono,monospace", color: "#ffffff" }}>{market}{isPower ? " \u00B2" : ""}</td>
                    <td style={{ padding: "8px", fontWeight: 600, color: sideCol }}>{sideLabel}</td>
                    <td style={{ padding: "8px", fontFamily: "IBM Plex Mono,monospace", color: "#ffffff" }}>{collAmt} {collType}</td>
                    <td style={{ padding: "8px", fontFamily: "IBM Plex Mono,monospace", color: "#ffffff" }}>${size}</td>
                    <td style={{ padding: "8px", fontFamily: "IBM Plex Mono,monospace", color: "#ffffff" }}>${entry}</td>
                    <td style={{ padding: "8px", color: isPower ? "#e2b85d" : "#8b949e" }}>{isPower ? "Squeeth" : "Standard"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
