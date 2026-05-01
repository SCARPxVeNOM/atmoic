import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { PositionView } from "../hooks/usePosition";
import { TradeRecord } from "../hooks/useTradeHistory";
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

const JLP_MINT = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

const HAIRCUTS: Record<string, number> = {
  [JLP_MINT]: 0.25,
  [MSOL_MINT]: 0.18,
};
const MAINT_MARGIN = 0.05; // 5%

function getCollateralDecimals(mint: string): number {
  return mint === JLP_MINT ? 6 : 9;
}

function getCollateralLabel(mint: string): string {
  if (mint === JLP_MINT) return "JLP";
  if (mint === MSOL_MINT) return "mSOL";
  return "SOL";
}

function getCollateralColor(mint: string): string {
  if (mint === JLP_MINT) return "#f59e0b";
  if (mint === MSOL_MINT) return "#06b6d4";
  return "#3fb68b";
}

type DeleverageZone = "safe" | "zone1" | "zone2" | "zone3" | "full";

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
  isPower: boolean;
  deleverageZone: DeleverageZone;
  deleverageBadge: string;
  deleverageBadgeCol: string;
  collateralLabel: string;
  collateralColor: string;
  collateralTokens: number;
  collateralPrice: number;
  liqPrice: number;
  openedAt: number;
}

function toDisplay(p: PositionView, prices: Record<string, number>, fallbackPrice: number): DisplayPosition {
  const collMint = p.collateralMint || "";
  const decimals = getCollateralDecimals(collMint);
  const collNative = Number(p.collateralAmount) / Math.pow(10, decimals);
  const notionalUsd = Number(p.borrowAmountUsdc) / 1e6;
  const entry = Number(p.entryPrice) / 1e6;
  const side: "Long" | "Short" = p.perpSide === 0 ? "Long" : "Short";

  const priceKey = FEED_TO_PRICE_KEY[p.perpMarket] || "sol";
  const markPrice = prices[priceKey] || fallbackPrice;
  const marketSymbol = FEED_TO_MARKET[p.perpMarket] || "SOL-PERP";
  const marketLabel = marketSymbol.replace("-PERP", "-USD");

  // Use correct collateral price based on collateral type
  // For SOL: use live SOL price. For JLP/mSOL: use entry price (best available).
  let collateralPrice: number;
  if (collMint === JLP_MINT || collMint === MSOL_MINT) {
    collateralPrice = Number(p.collateralEntryPrice) / 1e6;
  } else {
    collateralPrice = prices["sol"] || fallbackPrice;
  }

  const haircut = HAIRCUTS[collMint] || 0;
  const margin = collNative * collateralPrice * (1 - haircut);
  const lv = margin > 0 ? Math.round(notionalUsd / margin * 10) / 10 : 0;

  // Power-aware PnL
  const power = p.powerMilli || 0;
  const isPower = power === 2000;
  let pnlRaw: number;
  if (isPower && entry > 0) {
    const exitSq = markPrice * markPrice;
    const entrySq = entry * entry;
    const delta = (exitSq - entrySq) / entrySq;
    const sideMul = side === "Long" ? 1 : -1;
    pnlRaw = delta * notionalUsd * sideMul;
  } else {
    const priceDelta = side === "Long" ? markPrice - entry : entry - markPrice;
    pnlRaw = entry > 0 ? (priceDelta / entry) * notionalUsd : 0;
  }
  const pnlPct = margin > 0 ? (pnlRaw / margin) * 100 : 0;

  const marginRatio = notionalUsd > 0 ? margin / notionalUsd : 99;
  const marginPct = marginRatio * 100;
  const marginCol = marginPct > 15 ? "#3fb68b" : marginPct > 8 ? "#d29922" : "#ff5353";

  // Liquidation price estimate
  let liqPrice = 0;
  if (entry > 0 && notionalUsd > 0) {
    if (side === "Long") {
      liqPrice = entry * (1 + MAINT_MARGIN - marginRatio);
    } else {
      liqPrice = entry * (1 - MAINT_MARGIN + marginRatio);
    }
    if (liqPrice < 0) liqPrice = 0;
  }

  // Deleverage zone classification
  const dlZone: DeleverageZone =
    marginPct >= 5 ? "safe" :
    marginPct >= 4 ? "zone1" :
    marginPct >= 3 ? "zone2" :
    marginPct >= 2 ? "zone3" : "full";
  const dlBadge = dlZone === "safe" ? "SAFE" : dlZone === "zone1" ? "DL 25%" :
    dlZone === "zone2" ? "DL 50%" : dlZone === "zone3" ? "DL 75%" : "LIQ";
  const dlColor = dlZone === "safe" ? "#3fb68b" : dlZone === "zone1" ? "#d29922" :
    dlZone === "zone2" ? "#f59e0b" : dlZone === "zone3" ? "#ff5353" : "#991b1b";

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
    isPower,
    deleverageZone: dlZone,
    deleverageBadge: dlBadge,
    deleverageBadgeCol: dlColor,
    collateralLabel: getCollateralLabel(collMint),
    collateralColor: getCollateralColor(collMint),
    collateralTokens: collNative,
    collateralPrice,
    liqPrice,
    openedAt: Number(p.openedAt || 0),
  };
}

function fmtPrice(v: number): string {
  if (v >= 10000) return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1) return "$" + v.toFixed(2);
  return "$" + v.toFixed(4);
}

function timeAgo(ts: number): string {
  if (ts <= 0) return "-";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function PositionsTable({
  accentColor,
  positions: rawPositions,
  prices,
  solPrice,
  tradeHistory,
}: {
  accentColor: string;
  positions?: PositionView[];
  prices?: Record<string, number>;
  solPrice?: number;
  tradeHistory?: TradeRecord[];
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

  const COLS = ["Market", "Side", "Lv", "Size", "Collateral", "Entry", "Mark", "Liq Price", "PnL", "Margin %", ""];
  const rightAligned = ["Size", "Collateral", "Entry", "Mark", "Liq Price", "PnL"];

  return (
    <div style={{
      height: 240, flexShrink: 0,
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
                  {COLS.map(h => (
                    <th key={h} style={{
                      padding: "5px 10px", color: "#8b949e", fontWeight: 400,
                      textAlign: rightAligned.includes(h) ? "right" : "left",
                      whiteSpace: "nowrap", position: "sticky", top: 0, background: "#0d1117",
                      borderBottom: "1px solid #21262d",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayPositions.map((p, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #161b22" }}>
                    {/* Market + badges */}
                    <td style={{ padding: "6px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ color: "#e6edf3", fontWeight: 600 }}>{p.market}</span>
                        {p.isPower && <span style={{ fontSize: 9, color: "#a78bfa", background: "#1a0a2e", padding: "1px 4px", borderRadius: 3, fontWeight: 700 }}>{"\u00B2"}</span>}
                        <span style={{ fontSize: 9, color: p.collateralColor, background: `${p.collateralColor}18`, padding: "1px 4px", borderRadius: 3, fontWeight: 600 }}>{p.collateralLabel}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#484f58", marginTop: 1 }}>{timeAgo(p.openedAt)}</div>
                    </td>

                    {/* Side */}
                    <td style={{ padding: "6px 10px" }}>
                      <span style={{
                        color: p.side === "Long" ? "#3fb68b" : "#ff5353",
                        fontWeight: 700, display: "flex", alignItems: "center", gap: 3,
                      }}>
                        <span style={{ fontSize: 13 }}>{p.side === "Long" ? "\u2191" : "\u2193"}</span>
                        {p.side}
                      </span>
                    </td>

                    {/* Leverage */}
                    <td style={{ padding: "6px 10px", fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3", fontWeight: 600 }}>
                      {p.lv > 0 ? `${p.lv}x` : "-"}
                    </td>

                    {/* Size (notional) */}
                    <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>
                      {fmtPrice(p.sizeUsd)}
                    </td>

                    {/* Collateral */}
                    <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace" }}>
                      <div style={{ color: "#e6edf3" }}>{fmtPrice(p.margin / (1 - (HAIRCUTS[getCollateralMintFromLabel(p.collateralLabel)] || 0)))}</div>
                      <div style={{ fontSize: 10, color: "#484f58" }}>
                        {p.collateralTokens.toFixed(p.collateralLabel === "JLP" ? 4 : 6)} {p.collateralLabel}
                      </div>
                    </td>

                    {/* Entry */}
                    <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>
                      {fmtPrice(p.entry)}
                    </td>

                    {/* Mark */}
                    <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>
                      {fmtPrice(p.mark)}
                    </td>

                    {/* Liq Price */}
                    <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace" }}>
                      <span style={{ color: "#ff5353" }}>{p.liqPrice > 0 ? fmtPrice(p.liqPrice) : "-"}</span>
                    </td>

                    {/* PnL */}
                    <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace" }}>
                      <div style={{ color: p.pnl >= 0 ? "#3fb68b" : "#ff5353", fontWeight: 600 }}>
                        {p.pnl >= 0 ? "+" : ""}{fmtPrice(Math.abs(p.pnl))}
                      </div>
                      <div style={{ fontSize: 10, color: p.pnl >= 0 ? "#3fb68b" : "#ff5353" }}>
                        {p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(2)}%
                      </div>
                    </td>

                    {/* Margin % + Deleverage zone */}
                    <td style={{ padding: "6px 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: p.marginCol }}>
                          {(p.marginRatio * 100).toFixed(1)}%
                        </span>
                        <span style={{
                          fontSize: 8, fontWeight: 700, padding: "1px 4px", borderRadius: 3,
                          color: p.deleverageBadgeCol,
                          background: `${p.deleverageBadgeCol}18`,
                        }}>{p.deleverageBadge}</span>
                      </div>
                    </td>

                    {/* Close controls */}
                    <td style={{ padding: "6px 10px" }}>
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
        ) : tab === "history" ? (
          <TradeHistoryTab trades={tradeHistory || []} />
        ) : (
          <OrdersTab />
        )}
      </div>
    </div>
  );
}

function TradeHistoryTab({ trades }: { trades: TradeRecord[] }) {
  if (trades.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#8b949e", fontSize: 13 }}>
        No trade history yet. Close a position to see it here.
      </div>
    );
  }
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  return (
    <div>
      {/* Summary bar */}
      <div style={{ display: "flex", gap: 20, padding: "6px 12px", borderBottom: "1px solid #161b22", fontSize: 11, color: "#8b949e" }}>
        <span>Trades: <b style={{ color: "#e6edf3" }}>{trades.length}</b></span>
        <span>Wins: <b style={{ color: "#3fb68b" }}>{wins}</b></span>
        <span>Losses: <b style={{ color: "#ff5353" }}>{trades.length - wins}</b></span>
        <span>Win Rate: <b style={{ color: wins / trades.length > 0.5 ? "#3fb68b" : "#ff5353" }}>{(wins / trades.length * 100).toFixed(0)}%</b></span>
        <span>Total PnL: <b style={{ color: totalPnl >= 0 ? "#3fb68b" : "#ff5353" }}>{totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}</b></span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {["Market", "Side", "Collateral", "Size", "Entry", "Exit", "PnL", "Close %", "Time"].map(h => (
              <th key={h} style={{
                padding: "5px 10px", color: "#8b949e", fontWeight: 400,
                textAlign: ["Size", "Entry", "Exit", "PnL"].includes(h) ? "right" : "left",
                whiteSpace: "nowrap", position: "sticky", top: 0, background: "#0d1117",
                borderBottom: "1px solid #21262d",
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #161b22" }}>
              <td style={{ padding: "6px 10px", color: "#e6edf3", fontWeight: 600 }}>
                {t.market.replace("-PERP", "-USD")}
              </td>
              <td style={{ padding: "6px 10px" }}>
                <span style={{ color: t.side === "Long" ? "#3fb68b" : "#ff5353", fontWeight: 700 }}>
                  {t.side === "Long" ? "\u2191" : "\u2193"} {t.side}
                </span>
              </td>
              <td style={{ padding: "6px 10px" }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 3,
                  color: t.collateralType === "JLP" ? "#f59e0b" : t.collateralType === "mSOL" ? "#06b6d4" : "#3fb68b",
                  background: t.collateralType === "JLP" ? "#f59e0b18" : t.collateralType === "mSOL" ? "#06b6d418" : "#3fb68b18",
                }}>{t.collateralType}</span>
              </td>
              <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>
                ${t.size.toFixed(2)}
              </td>
              <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#8b949e" }}>
                ${t.entryPrice >= 1000 ? t.entryPrice.toFixed(2) : t.entryPrice.toFixed(4)}
              </td>
              <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>
                ${t.exitPrice >= 1000 ? t.exitPrice.toFixed(2) : t.exitPrice.toFixed(4)}
              </td>
              <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "IBM Plex Mono,monospace" }}>
                <span style={{ color: t.pnl >= 0 ? "#3fb68b" : "#ff5353", fontWeight: 600 }}>
                  {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(4)}
                </span>
              </td>
              <td style={{ padding: "6px 10px", fontFamily: "IBM Plex Mono,monospace", color: "#8b949e" }}>
                {t.closeBps >= 10000 ? "Full" : `${t.closeBps / 100}%`}
              </td>
              <td style={{ padding: "6px 10px", color: "#484f58", fontSize: 11 }}>
                {timeAgo(t.closedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrdersTab() {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#8b949e", fontSize: 13, gap: 8 }}>
      <div style={{ fontSize: 20 }}>{"\u{1F4CB}"}</div>
      <div>No open orders</div>
      <div style={{ fontSize: 11, color: "#484f58", maxWidth: 300, textAlign: "center" }}>
        Limit orders via DFBA (Discrete Frequent Batch Auction) will appear here. Use the DFBA tab to place batch orders.
      </div>
    </div>
  );
}

function getCollateralMintFromLabel(label: string): string {
  if (label === "JLP") return JLP_MINT;
  if (label === "mSOL") return MSOL_MINT;
  return "";
}
