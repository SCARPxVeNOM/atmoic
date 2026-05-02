import { FC, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { PositionView } from "../hooks/usePosition";
import { API_BASE } from "../config";
import { describeTransaction } from "../lib/tx-description";

const MARKETS = [
  { symbol: "SOL-PERP", label: "SOL", priceKey: "sol" },
  { symbol: "BTC-PERP", label: "BTC", priceKey: "btc" },
  { symbol: "ETH-PERP", label: "ETH", priceKey: "eth" },
];

const FEED_TO_MARKET: Record<string, string> = {
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": "SOL-PERP",
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": "BTC-PERP",
  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": "ETH-PERP",
};

const C = {
  bg:        "#000",
  panel:     "#0a0a0b",
  panel2:    "#111114",
  border:    "#1a1a1f",
  borderLit: "#26262e",
  t1:        "#ffffff",
  t2:        "#8b8b94",
  t3:        "#4a4a52",
  pos:       "#22c55e",
  posBg:     "rgba(34,197,94,0.10)",
  neg:       "#ef4444",
  negBg:     "rgba(239,68,68,0.10)",
  gold:      "#e2b85d",
  goldBright:"#ffe18a",
};
const MONO = "JetBrains Mono, IBM Plex Mono, Geist Mono, monospace";
const SANS = "Inter, system-ui, sans-serif";

export const SimplePanel: FC<{
  positions: PositionView[];
  prices: Record<string, number>;
  solPrice: number;
}> = ({ positions, prices, solPrice }) => {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("0.1");
  const [leverage, setLeverage] = useState(2);
  const [market, setMarket] = useState("SOL-PERP");
  const [powerMode, setPowerMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ side: "Long" | "Short"; desc: string } | null>(null);
  const [optimistic, setOptimistic] = useState<{ side: string; value: number } | null>(null);

  const marketInfo = MARKETS.find(m => m.symbol === market) || MARKETS[0];
  const markPrice = prices[marketInfo.priceKey] || solPrice;
  const collateralValue = Number(amount) * solPrice;
  const estValue = collateralValue * leverage;

  const positionForMarket = positions.find(p => FEED_TO_MARKET[p.perpMarket] === market);

  const sendTx = async (endpoint: string, body: any) => {
    if (!publicKey || !signTransaction) throw new Error("Connect wallet first");
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message ?? err.error ?? "Transaction failed");
    }
    const data = await res.json();
    const b64List: string[] = data.txs ?? [data.tx];
    const txList = b64List.map((b64: string) =>
      VersionedTransaction.deserialize(Buffer.from(b64, "base64"))
    );
    let signedList: VersionedTransaction[];
    if (signAllTransactions && txList.length > 1) {
      signedList = await signAllTransactions(txList);
    } else {
      signedList = [await signTransaction(txList[0])];
    }
    let sig = "";
    for (const signed of signedList) {
      sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");
    }
    return sig;
  };

  const requestOpen = (side: "Long" | "Short") => {
    const desc = describeTransaction({ type: "open", side, collateralSol: Number(amount), leverage, solPrice });
    setConfirm({ side, desc });
  };

  const executeOpen = async () => {
    if (!publicKey || !confirm) return;
    const { side } = confirm;
    setConfirm(null);
    setBusy(true);
    setStatus(null);
    setOptimistic({ side, value: estValue });
    try {
      const lamports = BigInt(Math.floor(Number(amount) * 1e9));
      await sendTx("/build-tx/open", {
        wallet: publicKey.toBase58(),
        collateralAmount: lamports.toString(),
        side,
        leverageBps: leverage * 1000,
        hedgeAmount: "0",
        useKamino: false,
        collateralType: "SOL",
        market,
        power: powerMode ? 2000 : 1000,
      });
      setStatus("Position opened");
      setOptimistic(null);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
      setOptimistic(null);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!publicKey) return;
    setBusy(true);
    setStatus(null);
    try {
      await sendTx("/build-tx/close", { wallet: publicKey.toBase58(), useKamino: false, market });
      setStatus("Position closed");
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const card: React.CSSProperties = {
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 0,
    fontFamily: SANS,
  };

  const label: React.CSSProperties = {
    fontSize: 10,
    color: C.t3,
    textTransform: "uppercase",
    letterSpacing: "0.10em",
    fontWeight: 500,
    marginBottom: 6,
  };

  // Optimistic banner
  if (optimistic && !positionForMarket?.isOpen) {
    return (
      <div style={{ ...card, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.gold }} />
          <span style={{ fontSize: 12, color: C.gold, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Confirming on Solana…
          </span>
        </div>
        <div style={{ fontSize: 28, fontFamily: MONO, fontWeight: 700, color: C.t1 }}>
          ${optimistic.value.toFixed(2)}
          <span style={{ fontSize: 13, color: C.t2, marginLeft: 10, fontWeight: 400 }}>
            {optimistic.side} {marketInfo.label}
          </span>
        </div>
        <div style={{ fontSize: 11, color: C.t3, marginTop: 6 }}>
          Transaction sent — waiting for block confirmation
        </div>
      </div>
    );
  }

  // Open position view
  if (positionForMarket?.isOpen) {
    const pos = positionForMarket;
    const entryPrice = Number(pos.entryPrice) / 1e6;
    const pnlRaw = (markPrice - entryPrice) *
      (Number(pos.perpSize) / 1e6 / markPrice) *
      (pos.perpSide === 0 ? 1 : -1);
    const collValue = Number(pos.collateralAmount) / 1e9 * solPrice;
    const pnlPct = collValue > 0 ? (pnlRaw / collValue) * 100 : 0;
    const sideLabel = pos.perpSide === 0 ? "Long" : "Short";
    const pnlCol = pnlRaw >= 0 ? C.pos : C.neg;

    return (
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 11, color: C.t2, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {marketInfo.label} Position
          </span>
          <div style={{ display: "flex", gap: 2 }}>
            {MARKETS.map(m => (
              <button key={m.symbol} onClick={() => setMarket(m.symbol)} style={{
                padding: "4px 10px", fontSize: 11, fontWeight: 600,
                border: `1px solid ${market === m.symbol ? C.borderLit : C.border}`,
                borderRadius: 0, background: market === m.symbol ? C.panel2 : "transparent",
                color: market === m.symbol ? C.t1 : C.t2, cursor: "pointer",
              }}>{m.label}</button>
            ))}
          </div>
        </div>

        <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ fontSize: 30, fontFamily: MONO, fontWeight: 700, color: C.t1, lineHeight: 1 }}>
              ${collValue.toFixed(2)}
            </div>
            <div style={{ fontSize: 12, color: C.t2, marginTop: 4 }}>
              {sideLabel} · {marketInfo.label} · ${markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "10px 0", borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
            <span style={{ color: C.t2 }}>Unrealized PnL</span>
            <span style={{ fontFamily: MONO, fontWeight: 700, color: pnlCol }}>
              {pnlRaw >= 0 ? "+" : ""}${pnlRaw.toFixed(2)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
            </span>
          </div>

          <button onClick={close} disabled={busy} style={{
            width: "100%", padding: "12px 0", border: `1px solid ${C.border}`,
            borderRadius: 0, background: busy ? C.panel2 : "transparent",
            color: busy ? C.t3 : C.neg, fontSize: 13, fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer", fontFamily: SANS,
            letterSpacing: "0.04em", textTransform: "uppercase",
            transition: "background 0.15s, border-color 0.15s",
          }}>
            {busy ? "Closing…" : "Close Position"}
          </button>
          {status && <div style={{ fontSize: 11, color: C.t2, textAlign: "center", fontFamily: MONO }}>{status}</div>}
        </div>
      </div>
    );
  }

  // Default trade form
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 11, color: C.t2, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500 }}>
          Start Trading
        </span>
        <div style={{ display: "flex", gap: 2 }}>
          {MARKETS.map(m => {
            const hasPos = positions.some(p => FEED_TO_MARKET[p.perpMarket] === m.symbol && p.isOpen);
            const active = market === m.symbol;
            return (
              <button key={m.symbol} onClick={() => setMarket(m.symbol)} style={{
                padding: "4px 10px", fontSize: 11, fontWeight: 600,
                border: `1px solid ${active ? C.borderLit : C.border}`,
                borderRadius: 0, background: active ? C.panel2 : "transparent",
                color: active ? C.t1 : C.t2, cursor: "pointer", position: "relative",
              }}>
                {m.label}
                {hasPos && <span style={{ position: "absolute", top: 2, right: 2, width: 4, height: 4, borderRadius: "50%", background: C.pos }} />}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: "18px 16px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Price */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.t3, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {marketInfo.label} Price
          </span>
          <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.t1 }}>
            ${markPrice < 100 ? markPrice.toFixed(2) : markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        </div>

        {/* Amount */}
        <div>
          <div style={label}>Amount (SOL)</div>
          <div style={{
            display: "flex", alignItems: "center",
            background: C.panel2, border: `1px solid ${C.border}`,
            borderRadius: 0, padding: "10px 12px", gap: 8,
          }}>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={!publicKey}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                fontSize: 20, fontFamily: MONO, color: C.t1, width: 0,
                fontFeatureSettings: "'tnum' 1",
              }}
              placeholder="0.1"
            />
            <span style={{ fontSize: 12, color: C.t2, fontWeight: 500, flexShrink: 0 }}>SOL</span>
          </div>
        </div>

        {/* Leverage */}
        <div>
          <div style={{ ...label, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span>Multiplier</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: C.t1, textTransform: "none", fontWeight: 700 }}>{leverage}x</span>
          </div>
          <input
            type="range" min={1} max={5} step={1} value={leverage}
            onChange={e => setLeverage(Number(e.target.value))}
            disabled={!publicKey}
            style={{ width: "100%", accentColor: C.gold, marginBottom: 4 }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.t3, fontFamily: MONO }}>
            <span>1x</span><span>5x</span>
          </div>
        </div>

        {/* Boost Mode */}
        <button
          onClick={() => setPowerMode(v => !v)}
          disabled={!publicKey}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 12px", borderRadius: 0,
            background: powerMode ? "rgba(226,184,93,0.07)" : C.panel2,
            border: `1px solid ${powerMode ? C.gold : C.border}`,
            cursor: publicKey ? "pointer" : "not-allowed", width: "100%",
            transition: "background 0.15s, border-color 0.15s",
          }}>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: powerMode ? C.goldBright : C.t1, letterSpacing: "0.02em" }}>
              Boost Mode (×²)
            </div>
            <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>
              {powerMode ? "Convex gains · 2x fees apply" : "Amplified payoff curve"}
            </div>
          </div>
          <div style={{
            width: 34, height: 18, borderRadius: 9, position: "relative", flexShrink: 0,
            background: powerMode ? C.gold : C.border, transition: "background 0.15s",
          }}>
            <div style={{
              width: 14, height: 14, borderRadius: 7,
              background: powerMode ? "#000" : C.t2,
              position: "absolute", top: 2,
              left: powerMode ? 18 : 2, transition: "left 0.15s, background 0.15s",
            }} />
          </div>
        </button>

        {/* Position value */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "10px 0", borderTop: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 11, color: C.t2 }}>Position value</span>
          <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.t1 }}>${estValue.toFixed(2)}</span>
        </div>

        {/* Confirm modal */}
        {confirm ? (
          <div style={{ background: C.panel2, border: `1px solid ${C.borderLit}`, borderRadius: 0, padding: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.t1, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Confirm Transaction
            </div>
            <div style={{ fontSize: 12, color: C.t2, marginBottom: 14, lineHeight: 1.6 }}>{confirm.desc}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={executeOpen} style={{
                flex: 1, padding: "10px 0", borderRadius: 0, border: 0,
                background: confirm.side === "Long" ? C.pos : C.neg,
                color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer",
                letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: SANS,
              }}>Confirm</button>
              <button onClick={() => setConfirm(null)} style={{
                flex: 1, padding: "10px 0", borderRadius: 0,
                border: `1px solid ${C.border}`, background: "transparent",
                color: C.t2, fontSize: 12, cursor: "pointer", fontFamily: SANS,
              }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 1, background: C.border }}>
            <button
              onClick={() => requestOpen("Long")}
              disabled={!publicKey || busy}
              style={{
                flex: 1, padding: "13px 0", borderRadius: 0, border: 0,
                background: !publicKey || busy ? C.panel2 : C.pos,
                color: !publicKey || busy ? C.t3 : "#000",
                fontSize: 13, fontWeight: 700, cursor: !publicKey || busy ? "not-allowed" : "pointer",
                letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: SANS,
                transition: "opacity 0.15s",
              }}>
              {busy ? "…" : `Long ${marketInfo.label}`}
            </button>
            <button
              onClick={() => requestOpen("Short")}
              disabled={!publicKey || busy}
              style={{
                flex: 1, padding: "13px 0", borderRadius: 0, border: 0,
                background: !publicKey || busy ? C.panel2 : C.neg,
                color: !publicKey || busy ? C.t3 : "#000",
                fontSize: 13, fontWeight: 700, cursor: !publicKey || busy ? "not-allowed" : "pointer",
                letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: SANS,
                transition: "opacity 0.15s",
              }}>
              {busy ? "…" : `Short ${marketInfo.label}`}
            </button>
          </div>
        )}

        {!publicKey && (
          <div style={{ fontSize: 11, color: C.t3, textAlign: "center", letterSpacing: "0.04em" }}>
            Connect wallet to start
          </div>
        )}
        {status && (
          <div style={{ fontSize: 11, color: C.t2, textAlign: "center", fontFamily: MONO }}>{status}</div>
        )}
      </div>
    </div>
  );
};
