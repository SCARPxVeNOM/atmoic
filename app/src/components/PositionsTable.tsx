import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { PositionView, HealthView } from "../hooks/usePosition";
import { API_BASE } from "../config";

interface DisplayPosition {
  market: string;
  side: "Long" | "Short";
  lv: number;
  sizeUsd: number;
  sizeSol: number;
  entry: number;
  mark: number;
  pnl: number;
  pnlPct: number;
  health: number;
  hc: string;
  hedgeUsd: number;
}

function toDisplay(p: PositionView, h: HealthView | null, solPrice: number): DisplayPosition {
  const collSol = Number(p.collateralAmount) / 1e9;
  const borrowUsdc = Number(p.borrowAmountUsdc) / 1e6;
  const entry = Number(p.entryPrice) / 1e6;
  const side: "Long" | "Short" = p.perpSide === 0 ? "Long" : "Short";
  const perpSizeSol = Number(p.perpSize) / 1e9;
  const sizeUsd = perpSizeSol * solPrice;
  const lv = borrowUsdc > 0 ? Math.round((collSol * solPrice + borrowUsdc) / (collSol * solPrice)) : 1;
  const pnlRaw = (solPrice - entry) * perpSizeSol * (side === "Long" ? 1 : -1);
  const pnlPct = collSol * solPrice > 0 ? (pnlRaw / (collSol * solPrice)) * 100 : 0;
  const healthBps = h ? Number(h.healthFactorBps) : 10000;
  const health = healthBps / 10000;
  const hc = health > 1.3 ? "#3fb68b" : health > 1.0 ? "#d29922" : "#ff5353";
  const hedgeUsdc = Number(p.hedgeAmount) / 1e6;

  return {
    market: "SOL-USD",
    side,
    lv,
    sizeUsd,
    sizeSol: perpSizeSol,
    entry,
    mark: solPrice,
    pnl: pnlRaw,
    pnlPct,
    health,
    hc,
    hedgeUsd: hedgeUsdc,
  };
}

export function PositionsTable({
  accentColor,
  position,
  health,
  solPrice,
}: {
  accentColor: string;
  position?: PositionView | null;
  health?: HealthView | null;
  solPrice?: number;
}) {
  const [tab, setTab] = useState("positions");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const accent = accentColor || "#58a6ff";
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  const price = solPrice || 0;
  const positions: DisplayPosition[] =
    position?.isOpen ? [toDisplay(position, health ?? null, price)] : [];

  const TABS = [
    { id: "positions", label: `Open Positions (${positions.length})` },
    { id: "orders", label: "Orders" },
    { id: "history", label: "Trade History" },
  ];

  const totalPnl = positions.reduce((s, p) => s + p.pnl, 0);

  const { signAllTransactions } = useWallet();

  const closePosition = async () => {
    if (!publicKey || !signTransaction) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`${API_BASE}/build-tx/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), useKamino: false }),
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
      setStatus(`Closed: ${lastSig.slice(0, 8)}...`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
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
          positions.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["Market", "Side", "Lv", "Size", "Entry", "Mark", "PnL", "Hedge", "Health", ""].map(h => (
                    <th key={h} style={{
                      padding: "5px 12px", color: "#8b949e", fontWeight: 400,
                      textAlign: ["Size", "Entry", "Mark", "PnL"].includes(h) ? "right" : "left",
                      whiteSpace: "nowrap", position: "sticky", top: 0, background: "#0d1117",
                      borderBottom: "1px solid #21262d",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => (
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
                      <div style={{ fontSize: 10, color: "#8b949e" }}>{p.sizeSol.toFixed(4)} SOL</div>
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
                      {p.hedgeUsd > 0 ? (
                        <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 12, color: "#58a6ff" }}>
                          ${p.hedgeUsd.toFixed(2)}
                          <span style={{ fontSize: 10, color: "#8b949e", marginLeft: 4 }}>via Jupiter</span>
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "#484f58" }}>None</span>
                      )}
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      <span style={{ fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: p.hc }}>{p.health.toFixed(2)}</span>
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      <button
                        disabled={busy}
                        onClick={closePosition}
                        style={{
                          padding: "4px 12px", borderRadius: 6, border: "1px solid #30363d",
                          background: "transparent", color: busy ? "#8b949e" : "#e6edf3", fontSize: 11,
                          cursor: busy ? "not-allowed" : "pointer", whiteSpace: "nowrap",
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
                      >{busy ? "Closing..." : "Close"}</button>
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
