import { useState, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { useBatchQueue } from "../hooks/useBatchQueue";
import { API_BASE } from "../config";

const CAP = 0.003;

function fmt(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n); }

function QueueRow({ price, size, side }: { price: number; size: number; side: "bid" | "ask" }) {
  const color = side === "bid" ? "#3fb68b" : "#ff5353";
  const maxSize = 2000;
  const pct = Math.min(size / maxSize, 1);
  return (
    <div style={{ position: "relative", padding: "6px 0", borderTop: "1px solid #21262d" }}>
      <div style={{
        position: "absolute", top: 0, bottom: 0,
        [side === "bid" ? "right" : "left"]: 0,
        width: `${pct * 100}%`,
        background: side === "bid" ? "rgba(63,182,139,0.07)" : "rgba(255,83,83,0.07)",
      }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, position: "relative" }}>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", color }}>${price.toFixed(2)}</span>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#ffffff" }}>{fmt(size)}</span>
      </div>
    </div>
  );
}

function Countdown({ accentColor }: { accentColor: string }) {
  const [secs, setSecs] = useState(12);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const t = setInterval(() => {
      setSecs(s => {
        if (s <= 1) { setFlash(true); setTimeout(() => setFlash(false), 600); return 15; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const urgent = secs <= 5;
  return (
    <div style={{ textAlign: "right", transition: "opacity 0.15s", opacity: flash ? 0.3 : 1 }}>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 2 }}>Next Batch In</div>
      <div style={{
        fontSize: 36, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700,
        color: urgent ? "#d29922" : accentColor, lineHeight: 1,
      }}>{secs}s</div>
    </div>
  );
}

export function DFBAView({ accentColor, solPrice }: { accentColor: string; solPrice?: number }) {
  const [orderSide, setOrderSide] = useState<"BID" | "ASK">("BID");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("500");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const accent = accentColor || "#58a6ff";
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const batchQueue = useBatchQueue();

  const oraclePrice = solPrice || 0;

  // Default price input to oracle price
  useEffect(() => {
    if (!price) setPrice(oraclePrice.toFixed(2));
  }, [oraclePrice]);

  const lastClearing = batchQueue?.clearingPrice ?? oraclePrice;

  // Placeholder queue rows based on oracle price
  const BID_QUEUE = [
    { price: oraclePrice + 0.50, size: 500 },
    { price: oraclePrice + 0.30, size: 1200 },
    { price: oraclePrice + 0.10, size: 800 },
    { price: oraclePrice - 0.20, size: 2000 },
  ];
  const ASK_QUEUE = [
    { price: oraclePrice, size: 300 },
    { price: oraclePrice + 0.20, size: 800 },
    { price: oraclePrice + 0.40, size: 1500 },
    { price: oraclePrice + 0.70, size: 400 },
  ];

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
    const { tx: b64 } = await res.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  };

  const placeOrder = async () => {
    if (!publicKey || !price || !size) return;
    setBusy(true);
    setStatus(null);
    try {
      const sig = await sendTx("/build-tx/place-order", {
        wallet: publicKey.toBase58(),
        price: BigInt(Math.floor(Number(price) * 1e6)).toString(),
        size: BigInt(Math.floor(Number(size) * 1e6)).toString(),
        side: orderSide === "BID" ? "Long" : "Short",
        market: "SOL-PERP",
      });
      setStatus(`Order placed: ${sig.slice(0, 8)}...`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelOrder = async () => {
    if (!publicKey) return;
    setBusy(true);
    setStatus(null);
    try {
      const sig = await sendTx("/build-tx/cancel-order", {
        wallet: publicKey.toBase58(),
        market: "SOL-PERP",
      });
      setStatus(`Order cancelled: ${sig.slice(0, 8)}...`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 24, background: "#000" }}>
      {/* Page header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#ffffff", margin: 0 }}>DFBA Batch Auction</h2>
            <span style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 20,
              background: "rgba(88,166,255,0.12)", color: accent, border: `1px solid ${accent}30`,
              fontWeight: 600, letterSpacing: "0.04em",
            }}>LIVE</span>
            {batchQueue && (
              <span style={{ fontSize: 11, color: "#8b949e", fontFamily: "IBM Plex Mono,monospace" }}>
                {batchQueue.bids}B / {batchQueue.asks}A in queue
              </span>
            )}
          </div>
          <p style={{ fontSize: 12, color: "#8b949e", margin: 0, maxWidth: 480 }}>
            Dual Flow Batch Auction &mdash; all orders in a 15-second window clear at a single uniform price.
            MEV-resistant &middot; no latency advantage &middot; makers compete on price only.
          </p>
        </div>
        <Countdown accentColor={accent} />
      </div>

      {/* Queues */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, marginBottom: 1, background: "#1a1a1f" }}>
        <div style={{ background: "#0a0a0b", borderRadius: 0, padding: 16, border: "1px solid #1a1a1f" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#3fb68b", letterSpacing: "0.02em" }}>BID QUEUE</span>
            <span style={{ fontSize: 11, color: "#8b949e" }}>Longs</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#8b949e", marginBottom: 4 }}>
            <span>PRICE</span><span>SIZE (USDC)</span>
          </div>
          {BID_QUEUE.map((o, i) => <QueueRow key={i} price={o.price} size={o.size} side="bid" />)}
        </div>

        <div style={{ background: "#0a0a0b", borderRadius: 0, padding: 16, border: "1px solid #1a1a1f" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#ff5353", letterSpacing: "0.02em" }}>ASK QUEUE</span>
            <span style={{ fontSize: 11, color: "#8b949e" }}>Shorts</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#8b949e", marginBottom: 4 }}>
            <span>PRICE</span><span>SIZE (USDC)</span>
          </div>
          {ASK_QUEUE.map((o, i) => <QueueRow key={i} price={o.price} size={o.size} side="ask" />)}
        </div>
      </div>

      {/* Pyth oracle center line */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
        background: "#0a0a0b", borderRadius: 0, border: "1px solid #1a1a1f", marginBottom: 1, fontSize: 12,
      }}>
        <span style={{ color: "#8b949e" }}>Pyth Oracle</span>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: accent, fontSize: 15 }}>${oraclePrice.toFixed(2)}</span>
        <span style={{ color: "#1a1a1f" }}>&middot;</span>
        <span style={{ color: "#8b949e" }}>Cap &plusmn;0.3%</span>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#ffffff" }}>
          ${(oraclePrice * (1 - CAP)).toFixed(2)} &ndash; ${(oraclePrice * (1 + CAP)).toFixed(2)}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#8b949e" }}>Orders outside cap are rejected</span>
      </div>

      {/* Place order */}
      <div style={{ background: "#0a0a0b", borderRadius: 0, padding: 20, border: "1px solid #1a1a1f", marginBottom: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", marginBottom: 14 }}>Place Order</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Side</div>
            <div style={{ display: "flex" }}>
              {(["BID", "ASK"] as const).map(s => {
                const col = s === "BID" ? "#3fb68b" : "#ff5353";
                const active = orderSide === s;
                return (
                  <button key={s} onClick={() => setOrderSide(s)} style={{
                    padding: "8px 18px", border: "1px solid #1a1a1f", cursor: "pointer", fontSize: 13, fontWeight: 700,
                    background: active ? `${col}20` : "#0d1117",
                    color: active ? col : "#8b949e",
                    borderRadius: 0,
                    transition: "all 0.15s",
                  }}>{s} {s === "BID" ? "(Long)" : "(Short)"}</button>
                );
              })}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 120 }}>
            <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Price ($)</div>
            <input value={price} onChange={e => setPrice(e.target.value)} style={{
              width: "100%", background: "#000", border: "1px solid #1a1a1f", borderRadius: 0,
              padding: "8px 10px", color: "#ffffff", fontFamily: "IBM Plex Mono,monospace",
              fontSize: 14, outline: "none", boxSizing: "border-box",
            }} />
          </div>

          <div style={{ flex: 1, minWidth: 120 }}>
            <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Size (USDC)</div>
            <input value={size} onChange={e => setSize(e.target.value)} style={{
              width: "100%", background: "#000", border: "1px solid #1a1a1f", borderRadius: 0,
              padding: "8px 10px", color: "#ffffff", fontFamily: "IBM Plex Mono,monospace",
              fontSize: 14, outline: "none", boxSizing: "border-box",
            }} />
          </div>

          <button
            disabled={busy || !publicKey}
            onClick={placeOrder}
            style={{
              padding: "9px 24px", borderRadius: 0, border: "none",
              background: !publicKey || busy ? "#21262d" : orderSide === "BID" ? "#3fb68b" : "#ff5353",
              color: !publicKey || busy ? "#8b949e" : "#fff",
              fontSize: 13, fontWeight: 700,
              cursor: !publicKey || busy ? "not-allowed" : "pointer", whiteSpace: "nowrap",
            }}>{busy ? "Submitting..." : "Place Order"}</button>
        </div>
        {status && (
          <div style={{ marginTop: 10, fontSize: 11, color: "#8b949e" }}>{status}</div>
        )}
      </div>

      {/* Bottom row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "#1a1a1f" }}>
        <div style={{ background: "#0a0a0b", borderRadius: 0, padding: 14, border: "1px solid #1a1a1f" }}>
          <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Last Batch Result</div>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <span style={{ color: "#8b949e" }}>Cleared @ </span>
            <span style={{ fontFamily: "IBM Plex Mono,monospace", color: accent, fontWeight: 700 }}>${lastClearing.toFixed(2)}</span>
            <span style={{ color: "#8b949e" }}> &middot; Vol </span>
            <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#ffffff" }}>
              ${batchQueue ? fmt(batchQueue.totalVolume) : "—"}
            </span>
          </div>
        </div>

        <div style={{ background: "#0a0a0b", borderRadius: 0, padding: 14, border: "1px solid #1a1a1f" }}>
          <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Your Orders</div>
          {publicKey ? (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "#8b949e" }}>Check on-chain for active orders</span>
              <button
                disabled={busy}
                onClick={cancelOrder}
                style={{
                  padding: "3px 10px", background: "transparent",
                  border: "1px solid #1a1a1f", borderRadius: 0,
                  color: "#ff5353", fontSize: 11,
                  cursor: busy ? "not-allowed" : "pointer",
                }}>Cancel All</button>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#8b949e" }}>Connect wallet to view orders</div>
          )}
        </div>
      </div>
    </div>
  );
}
