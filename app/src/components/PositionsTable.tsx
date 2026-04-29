import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { PositionView } from "../hooks/usePosition";
import { API_BASE } from "../config";

// Map Pyth feed pubkeys to market symbols
const FEED_TO_MARKET: Record<string, string> = {
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": "SOL-PERP",
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": "BTC-PERP",
  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": "ETH-PERP",
};

const FEED_TO_PRICE_KEY: Record<string, string> = {
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": "sol",
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": "btc",
  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": "eth",
};

// JLP has 6 decimals, SOL/mSOL have 9
const JLP_MINT = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";

function getCollateralDecimals(collateralMint: string): number {
  return collateralMint === JLP_MINT ? 6 : 9;
}

interface DisplayPosition {
  market: string;
  marketSymbol: string;
  side: "Long" | "Short";
  lv: number;
  sizeUsd: number;
  margin: number;
  entry: number;
  mark: number;
  pnl: number;
  pnlPct: number;
  marginRatio: number;
  marginCol: string;
}

function toDisplay(p: PositionView, prices: Record<string, number>, fallbackPrice: number): DisplayPosition {
  const decimals = getCollateralDecimals(p.collateralMint || "");
  const collNative = Number(p.collateralAmount) / Math.pow(10, decimals);
  const notionalUsd = Number(p.borrowAmountUsdc) / 1e6;
  const entry = Number(p.entryPrice) / 1e6;
  const side: "Long" | "Short" = p.perpSide === 0 ? "Long" : "Short";

  const priceKey = FEED_TO_PRICE_KEY[p.perpMarket] || "sol";
  const markPrice = prices[priceKey] || fallbackPrice;
  const marketSymbol = FEED_TO_MARKET[p.perpMarket] || "SOL-PERP";
  const marketLabel = marketSymbol.replace("-PERP", "-USD");

  // For margin calculation, we need collateral value in USD
  // Collateral is always denominated in SOL (for SOL collateral), so use SOL price
  const solPrice = prices["sol"] || fallbackPrice;
  const margin = collNative * solPrice;
  const lv = margin > 0 ? Math.round(notionalUsd / margin) : 1;

  const priceDelta = side === "Long" ? markPrice - entry : entry - markPrice;
  const pnlRaw = entry > 0 ? (priceDelta / entry) * notionalUsd : 0;
  const pnlPct = margin > 0 ? (pnlRaw / margin) * 100 : 0;

  const marginRatio = notionalUsd > 0 ? margin / notionalUsd : 99;
  const marginPct = marginRatio * 100;
  const marginCol = marginPct > 15 ? "#3fb68b" : marginPct > 8 ? "#d29922" : "#ff5353";

  return {
    market: marketLabel,
    marketSymbol,
    side,
    lv,
    sizeUsd: notionalUsd,
    margin,
    entry,
    mark: markPrice,
    pnl: pnlRaw,
    pnlPct,
    marginRatio,
    marginCol,
  };
}

export function PositionsTable({
  accentColor,
  positions: rawPositions,
  prices,
  solPrice,
}: {
  accentColor: string;
  positions?: PositionView[];
  prices?: Record<string, number>;
  solPrice?: number;
}) {
  const [tab, setTab] = useState("positions");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [closePercent, setClosePercent] = useState(100);
  const accent = accentColor || "#58a6ff";
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();

  const price = solPrice || 0;
  const priceMap = prices || {};
  const openPositions = (rawPositions || []).filter(p => p.isOpen);
  const displayPositions: DisplayPosition[] = openPositions.map(p => toDisplay(p, priceMap, price));

  const TABS = [
    { id: "positions", label: `Open Positions (${displayPositions.length})` },
    { id: "orders", label: "Orders" },
    { id: "history", label: "Trade History" },
  ];

  const totalPnl = displayPositions.reduce((s, p) => s + p.pnl, 0);

  const closePosition = async (marketSymbol: string) => {
    if (!publicKey || !signTransaction) return;
    setBusy(marketSymbol);
    setStatus(null);
    try {
      const closeBps = Math.round(closePercent * 100);
      const res = await fetch(`${API_BASE}/build-tx/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), closeBps, market: marketSymbol }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "build failed");
      const data = await res.json();
      const b64List: string[] = data.txs ?? [data.tx];
      const txList = b64List.map((b64: string) =>
        VersionedTransaction.deserialize(Buffer.from(b64, "base64"))
      );

      let signedList: VersionedTransaction[];
      if (signAllTransactions && txList.length > 1) {
        signedList = await signAllTransactions(txList);
      } else {
        signedList = [];
        for (const tx of txList) {
          signedList.push(await signTransaction(tx));
        }
      }

      let lastSig = "";
      for (const signed of signedList) {
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        lastSig = sig;
      }
      const label = closePercent < 100 ? `Closed ${closePercent}%` : "Closed";
      setStatus(`${label}: ${lastSig.slice(0, 8)}...`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{
      height: 220, flexShrink: 0,
      borderTop: "1px solid #30363d", background: "#0d1117",
      display: "flex", flexDirection: "column",
    }}>
      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid #30363d", padding: "0 4px", flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "7px 14px", fontSize: 12, fontWeight: 500,
            border: "none", background: "transparent", cursor: "pointer",
            color: tab === t.id ? "#e6edf3" : "#8b949e",
            borderBottom: `2px solid ${tab === t.id ? accent : "transparent"}`,
            transition: "color 0.15s",
          }}>{t.label}</button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingRight: 12, fontSize: 11, color: "#8b949e" }}>
          <span>Total PnL: </span>
          <span style={{
            fontFamily: "IBM Plex Mono,monospace",
            color: totalPnl >= 0 ? "#3fb68b" : "#ff5353",
            fontWeight: 600, marginLeft: 4,
          }}>{totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}</span>
          {status && (
            <span style={{ marginLeft: 12, fontSize: 10, color: "#8b949e" }}>{status}</span>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {tab === "positions" ? (
          displayPositions.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["Market", "Side", "Lv", "Size", "Margin", "Entry", "Mark", "PnL", "Margin %", ""].map(h => (
                    <th key={h} style={{
                      padding: "5px 12px", color: "#8b949e", fontWeight: 400,
                      textAlign: ["Size", "Margin", "Entry", "Mark", "PnL"].includes(h) ? "right" : "left",
                      whiteSpace: "nowrap", position: "sticky", top: 0, background: "#0d1117",
                      borderBottom: "1px solid #21262d",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayPositions.map((p, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #161b22" }}>
                    <td style={{ padding: "8px 12px", color: "#e6edf3", fontWeight: 600 }}>{p.market}</td>
                    <td style={{ padding: "8px 12px" }}>
                      <span style={{
                        color: p.side === "Long" ? "#3fb68b" : "#ff5353",
                        fontWeight: 700, display: "flex", alignItems: "center", gap: 4,
                      }}>
                        <span style={{ fontSize: 14 }}>{p.side === "Long" ? "\u2191" : "\u2193"}</span>
                        {p.side}
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px", fontFamily: "IBM Plex Mono,monospace", color: "#8b949e" }}>{p.lv}x</td>
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace" }}>
                      <div style={{ color: "#e6edf3" }}>${p.sizeUsd.toFixed(2)}</div>
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#8b949e" }}>
                      ${p.margin.toFixed(2)}
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>${p.entry.toFixed(2)}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>${p.mark.toFixed(2)}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace" }}>
                      <div style={{ color: p.pnl >= 0 ? "#3fb68b" : "#ff5353", fontWeight: 600 }}>
                        {p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}
                      </div>
                      <div style={{ fontSize: 10, color: p.pnl >= 0 ? "#3fb68b" : "#ff5353" }}>
                        {p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(2)}%
                      </div>
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      <span style={{ fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: p.marginCol }}>
                        {(p.marginRatio * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ display: "flex", gap: 2 }}>
                          {[25, 50, 100].map(pct => (
                            <button key={pct} onClick={() => setClosePercent(pct)} style={{
                              padding: "2px 5px", borderRadius: 3, fontSize: 9,
                              border: `1px solid ${closePercent === pct ? "#ff5353" : "#30363d"}`,
                              background: closePercent === pct ? "#ff535318" : "transparent",
                              color: closePercent === pct ? "#ff5353" : "#8b949e",
                              cursor: "pointer",
                            }}>{pct}%</button>
                          ))}
                        </div>
                        <button
                          disabled={busy === p.marketSymbol}
                          onClick={() => closePosition(p.marketSymbol)}
                          style={{
                            padding: "4px 10px", borderRadius: 6, border: "1px solid #30363d",
                            background: "transparent", color: busy === p.marketSymbol ? "#8b949e" : "#e6edf3", fontSize: 11,
                            cursor: busy === p.marketSymbol ? "not-allowed" : "pointer", whiteSpace: "nowrap",
                          }}
                          onMouseEnter={e => {
                            if (busy) return;
                            const t = e.currentTarget;
                            t.style.background = "#ff535318";
                            t.style.borderColor = "#ff5353";
                            t.style.color = "#ff5353";
                          }}
                          onMouseLeave={e => {
                            const t = e.currentTarget;
                            t.style.background = "transparent";
                            t.style.borderColor = "#30363d";
                            t.style.color = "#e6edf3";
                          }}
                        >{busy === p.marketSymbol ? "Closing..." : closePercent < 100 ? `Close ${closePercent}%` : "Close"}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#8b949e", fontSize: 13 }}>
              No open positions
            </div>
          )
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#8b949e", fontSize: 13 }}>
            No {tab === "orders" ? "open orders" : "trade history"}
          </div>
        )}
      </div>
    </div>
  );
}
