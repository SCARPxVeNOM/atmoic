import { useState, useMemo, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { API_BASE } from "../config";
import { usePrivySession } from "../hooks/usePrivySession";

const COLLATERAL = [
  { id: "SOL", label: "SOL", cut: 0, icon: "\u25CE" },
  { id: "JLP", label: "JLP", cut: 25, icon: "\u2B21" },
  { id: "mSOL", label: "mSOL", cut: 18, icon: "\u25C8" },
];

const LV_PRESETS = [2, 3, 5, 10];

/** Maintenance margin: 5%. Matches on-chain MAINTENANCE_MARGIN_BPS = 500. */
const MAINTENANCE_MARGIN_PCT = 0.05;

function SummaryRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12 }}>
      <span style={{ color: "#8b949e" }}>{label}</span>
      <span style={{ fontFamily: "IBM Plex Mono,monospace", color: color || "#e6edf3" }}>{value}</span>
    </div>
  );
}

interface VaultRisk {
  spreadBps: number;
  skewPct: number;
  suspended: boolean;
}

const MARKET_TO_PERP: Record<string, string> = {
  "SOL-USD": "SOL-PERP",
  "BTC-USD": "BTC-PERP",
  "ETH-USD": "ETH-PERP",
};

const MARKET_TO_KEY: Record<string, string> = {
  "SOL-USD": "sol",
  "BTC-USD": "btc",
  "ETH-USD": "eth",
};

export function TradePanel({
  accentColor,
  solPrice,
  showProData,
  activeMarket,
  prices,
}: {
  accentColor: string;
  solPrice?: number;
  showProData?: boolean;
  activeMarket?: string;
  prices?: Record<string, number>;
}) {
  const [side, setSide] = useState<"Long" | "Short">("Long");
  const [col, setCol] = useState("SOL");
  const [amount, setAmount] = useState("0.5");
  const [leverage, setLeverage] = useState(5);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDesc, setConfirmDesc] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<{ side: string; value: number } | null>(null);
  const [vaultRisk, setVaultRisk] = useState<VaultRisk | null>(null);

  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const privy = usePrivySession();

  const accent = accentColor || "#58a6ff";
  const perpMarket = MARKET_TO_PERP[activeMarket || "SOL-USD"] || "SOL-PERP";
  const priceKey = MARKET_TO_KEY[activeMarket || "SOL-USD"] || "sol";
  const markPrice = prices?.[priceKey] || solPrice || 0;
  const price = solPrice || 0; // SOL price for collateral value
  const sol = parseFloat(amount) || 0;
  const cut = COLLATERAL.find(c => c.id === col)?.cut || 0;

  // Fetch collateral price for non-SOL collateral types
  const [collPrice, setCollPrice] = useState<number>(0);
  useEffect(() => {
    if (col === "SOL") { setCollPrice(price); return; }
    const mint = col === "JLP"
      ? "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"
      : "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
    fetch(`https://api.jup.ag/price/v3?ids=${mint}`)
      .then(r => r.json())
      .then(d => { if (d[mint]?.usdPrice) setCollPrice(Number(d[mint].usdPrice)); })
      .catch(() => {});
  }, [col, price]);

  // effectivePrice: USD value per 1 unit of the selected collateral token
  const effectivePrice = col === "SOL" ? price : collPrice;

  // Fetch vault risk for Pro mode
  useEffect(() => {
    if (!showProData) return;
    const tick = () => {
      fetch(`${API_BASE}/vault/risk`).then(r => r.json()).then(setVaultRisk).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, [showProData]);

  const summary = useMemo(() => {
    const collUsd = sol * effectivePrice;
    const effColl = collUsd * (1 - cut / 100);
    const notional = collUsd * leverage;
    const fee = notional * 0.001; // 10bps on notional
    const netCollUsd = collUsd - fee; // after fee deduction
    const entryPrice = price * (side === "Long" ? 1.0003 : 0.9997);

    // Margin ratio = effective_collateral / notional
    const marginRatio = notional > 0 ? effColl / notional : 9.99;

    // Liquidation price: when margin ratio hits MAINTENANCE_MARGIN_PCT (5%)
    // For SOL collateral on SOL-perp (correlated):
    //   effectiveMargin(P) = collateral_in_sol * P + PnL(P)
    //   For long: PnL = (P - entry) / entry * notional
    //   Solve for P where effectiveMargin / notional = 0.05
    const collSol = sol;
    const liqPrice = (() => {
      if (notional <= 0 || entryPrice <= 0) return 0;
      // effectiveMargin = collSol * P * (1 - cut/100) + (P - entry)/entry * notional (for long)
      // Set = maintenanceMargin * notional and solve for P
      const target = MAINTENANCE_MARGIN_PCT * notional;
      const cutFactor = (1 - cut / 100);
      if (side === "Long") {
        // collSol * P * cutFactor + (P - entry) * notional / entry = target
        // P * (collSol * cutFactor + notional / entry) = target + notional
        const denom = collSol * cutFactor + notional / entryPrice;
        return denom > 0 ? (target + notional) / denom : 0;
      } else {
        // collSol * P * cutFactor + (entry - P) * notional / entry = target
        // P * (collSol * cutFactor - notional / entry) = target - notional
        const denom = collSol * cutFactor - notional / entryPrice;
        if (denom >= 0) return 0; // can't liquidate (very low leverage short)
        return (target - notional) / denom;
      }
    })();

    // Color coding for margin ratio
    const marginPct = marginRatio * 100;
    const healthCol = marginPct > 15 ? "#3fb68b" : marginPct > 8 ? "#d29922" : "#ff5353";

    return { notional, entryPrice, liqPrice, fee, marginRatio, healthCol };
  }, [sol, effectivePrice, price, leverage, side, cut]);

  const sideColor = side === "Long" ? "#3fb68b" : "#ff5353";
  const btnDisabled = sol <= 0 || !publicKey || busy;

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

    return lastSig;
  };

  const requestOpen = () => {
    const collLabel = col === "SOL" ? `${sol} SOL` : `${sol} ${col}`;
    const notionalUsd = summary.notional.toFixed(2);
    const desc = `Open ${leverage}x ${side} \u2014 Deposit ${collLabel} ($${(sol * effectivePrice).toFixed(2)}) as margin, ${side.toLowerCase()} $${notionalUsd} notional${col !== "SOL" ? ` (auto-converts SOL \u2192 ${col})` : ""}`;
    setConfirmDesc(desc);
  };

  const executeOpen = async () => {
    if (!publicKey) return;
    setConfirmDesc(null);
    setBusy(true);
    setStatus(null);
    setOptimistic({ side, value: summary.notional });
    try {
      const decimals = col === "JLP" ? 6 : 9;
      const collAmount = BigInt(Math.floor(sol * 10 ** decimals));
      const sig = await sendTx("/build-tx/open", {
        wallet: publicKey.toBase58(),
        collateralAmount: collAmount.toString(),
        side,
        leverageBps: leverage * 1000,
        collateralType: col,
        market: perpMarket,
      });
      setStatus(`Opened: ${sig.slice(0, 8)}...`);
      setOptimistic(null);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
      setOptimistic(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      width: 340, flexShrink: 0,
      background: "#0d1117", borderLeft: "1px solid #30363d",
      display: "flex", flexDirection: "column", overflowY: "auto",
    }}>
      {/* Long / Short toggle */}
      <div style={{ display: "flex", borderBottom: "1px solid #30363d", flexShrink: 0 }}>
        {(["Long", "Short"] as const).map(s => {
          const sc = s === "Long" ? "#3fb68b" : "#ff5353";
          const active = side === s;
          return (
            <button key={s} onClick={() => setSide(s)} style={{
              flex: 1, padding: "13px 0", fontSize: 14, fontWeight: 700,
              border: "none", cursor: "pointer", letterSpacing: "-0.01em",
              background: active ? (s === "Long" ? "rgba(63,182,139,0.1)" : "rgba(255,83,83,0.1)") : "transparent",
              color: active ? sc : "#8b949e",
              borderBottom: `2px solid ${active ? sc : "transparent"}`,
              transition: "all 0.15s",
            }}>{s}</button>
          );
        })}
      </div>

      <div style={{ padding: "16px 16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Collateral chips */}
        <div>
          <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Collateral</div>
          <div style={{ display: "flex", gap: 8 }}>
            {COLLATERAL.map(c => {
              const active = col === c.id;
              return (
                <button key={c.id} onClick={() => setCol(c.id)} style={{
                  flex: 1, padding: "9px 6px", borderRadius: 8,
                  border: `1px solid ${active ? accent : "#30363d"}`,
                  background: active ? `${accent}18` : "#161b22",
                  cursor: "pointer", textAlign: "center", transition: "all 0.15s",
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: active ? accent : "#e6edf3" }}>{c.label}</div>
                  <div style={{ fontSize: 10, color: "#8b949e", marginTop: 2 }}>{c.cut}% cut</div>
                </button>
              );
            })}
          </div>
          {col !== "SOL" && (
            <div style={{ fontSize: 10, color: "#58a6ff", marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}>
              {"\u26A1"} Auto-converts SOL {"\u2192"} {col} via Jupiter on deposit
            </div>
          )}
        </div>

        {/* Amount input */}
        <div>
          <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
            Deposit Amount {col !== "SOL" && <span style={{ color: "#58a6ff" }}>(in {col})</span>}
          </div>
          <div style={{
            display: "flex", alignItems: "center", background: "#161b22",
            border: "1px solid #30363d", borderRadius: 8, padding: "9px 12px", gap: 8,
          }}>
            <input
              type="number" value={amount}
              onChange={e => setAmount(e.target.value)}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                fontSize: 18, fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3", width: 0,
              }}
            />
            <span style={{ fontSize: 13, color: "#8b949e", flexShrink: 0 }}>{col}</span>
            <button style={{
              fontSize: 10, color: accent, background: `${accent}18`,
              border: `1px solid ${accent}40`, borderRadius: 4, padding: "2px 7px",
              cursor: "pointer", flexShrink: 0,
            }}>MAX</button>
          </div>
          <div style={{ fontSize: 11, color: "#8b949e", marginTop: 5, fontFamily: "IBM Plex Mono,monospace" }}>
            &asymp; ${(sol * effectivePrice).toFixed(2)}
          </div>
        </div>

        {/* Leverage */}
        <div>
          <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Leverage</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {LV_PRESETS.map(lv => {
              const active = leverage === lv;
              return (
                <button key={lv} onClick={() => setLeverage(lv)} style={{
                  flex: 1, padding: "6px 0", borderRadius: 6,
                  border: `1px solid ${active ? accent : "#30363d"}`,
                  background: active ? `${accent}18` : "#161b22",
                  color: active ? accent : "#8b949e",
                  fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all 0.15s",
                }}>{lv}x</button>
              );
            })}
          </div>
          <input type="range" min={1} max={10} step={0.5} value={leverage}
            onChange={e => setLeverage(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: accent }} />
          <div style={{
            textAlign: "center", fontSize: 13, color: accent,
            fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, marginTop: 5,
          }}>{leverage.toFixed(1)}x</div>
        </div>

        {/* Pro mode: Vault risk info */}
        {showProData && vaultRisk && (
          <div style={{
            display: "flex", gap: 8, fontSize: 11,
            background: "#161b22", borderRadius: 8, padding: "8px 12px",
            border: "1px solid #30363d",
          }}>
            <span style={{ color: "#8b949e" }}>Spread</span>
            <span style={{ fontFamily: "IBM Plex Mono,monospace", color: vaultRisk.suspended ? "#ff5353" : "#e6edf3" }}>
              {vaultRisk.suspended ? "SUSPENDED" : `${vaultRisk.spreadBps} bps`}
            </span>
            <span style={{ color: "#30363d" }}>&middot;</span>
            <span style={{ color: "#8b949e" }}>Skew</span>
            <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>{vaultRisk.skewPct}%</span>
          </div>
        )}

        {/* Order summary */}
        <div style={{ background: "#161b22", borderRadius: 10, padding: "12px 14px", border: "1px solid #30363d" }}>
          <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Order Summary</div>
          <div style={{ borderBottom: "1px solid #30363d", paddingBottom: 8, marginBottom: 8 }}>
            <SummaryRow label="Margin" value={`$${(sol * effectivePrice).toFixed(2)}`} />
            <SummaryRow label="Position Size" value={`$${summary.notional.toFixed(2)}`} />
            <SummaryRow label="Entry Price" value={`$${summary.entryPrice.toFixed(2)}`} />
            <SummaryRow label="Liq. Price" value={`$${summary.liqPrice.toFixed(2)}`} color="#ff5353" />
            <SummaryRow label="Spread" value={vaultRisk ? `${vaultRisk.spreadBps} bps` : "5 bps"} />
            <SummaryRow label="Fee (10bps)" value={`$${summary.fee.toFixed(3)}`} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "#8b949e" }}>Margin Ratio</span>
            <span style={{ fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: summary.healthCol }}>
              {(summary.marginRatio * 100).toFixed(1)}%
              {" "}<span style={{ fontSize: 8 }}>&bull;</span>
            </span>
          </div>
        </div>

        {/* Confirmation modal */}
        {confirmDesc && (
          <div style={{
            background: "#161b22", borderRadius: 10, padding: "14px",
            border: `1px solid ${accent}40`,
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3", marginBottom: 8 }}>Confirm Transaction</div>
            <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 12, lineHeight: 1.5 }}>{confirmDesc}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={executeOpen} style={{
                flex: 1, padding: "10px 0", borderRadius: 8, border: "none",
                background: sideColor, color: "#fff", fontSize: 13,
                fontWeight: 700, cursor: "pointer",
              }}>Confirm</button>
              <button onClick={() => setConfirmDesc(null)} style={{
                flex: 1, padding: "10px 0", borderRadius: 8,
                border: "1px solid #30363d", background: "transparent",
                color: "#8b949e", fontSize: 13, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Optimistic confirmation */}
        {optimistic && !confirmDesc && (
          <div style={{
            background: "#161b22", borderRadius: 10, padding: "14px",
            border: `1px solid ${accent}40`, textAlign: "center",
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%", background: accent,
              margin: "0 auto 8px", animation: "pulse 1.5s infinite",
            }} />
            <div style={{ fontSize: 13, color: accent, fontWeight: 600, marginBottom: 4 }}>
              Confirming on Solana...
            </div>
            <div style={{ fontSize: 12, fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3" }}>
              {optimistic.side} ${optimistic.value.toFixed(2)}
            </div>
            <div style={{ fontSize: 11, color: "#8b949e", marginTop: 4 }}>
              Transaction sent — waiting for block confirmation
            </div>
          </div>
        )}

        {/* Privy session key toggle */}
        {privy.enabled && publicKey && !confirmDesc && !optimistic && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 12px", background: "#161b22", borderRadius: 8,
            border: "1px solid #30363d", fontSize: 11,
          }}>
            <div>
              <span style={{ color: "#8b949e" }}>Session Key </span>
              {privy.session?.active ? (
                <span style={{ color: "#3fb68b", fontWeight: 600 }}>
                  Active ({privy.remainingCap.toFixed(2)} SOL left)
                </span>
              ) : (
                <span style={{ color: "#8b949e" }}>Off</span>
              )}
            </div>
            <button
              onClick={() => privy.session?.active ? privy.endSession() : privy.startSession(1.0)}
              style={{
                padding: "3px 10px", borderRadius: 4, border: "1px solid #30363d",
                background: "transparent", cursor: "pointer", fontSize: 11,
                color: privy.session?.active ? "#ff5353" : accent,
              }}
            >{privy.session?.active ? "End" : "Start"}</button>
          </div>
        )}

        {/* CTA */}
        {!confirmDesc && !optimistic && (
          <>
            <button
              disabled={btnDisabled}
              onClick={requestOpen}
              style={{
                width: "100%", padding: "14px 0", borderRadius: 10, border: "none",
                background: btnDisabled ? "#21262d" : sideColor,
                color: btnDisabled ? "#8b949e" : "#fff",
                fontSize: 15, fontWeight: 700, cursor: btnDisabled ? "not-allowed" : "pointer",
                letterSpacing: "-0.01em", transition: "opacity 0.15s",
              }}>
              {busy ? "Submitting..." : `Open ${side} \u25B8`}
            </button>
            <div style={{ textAlign: "center", fontSize: 11, color: "#8b949e", marginTop: -6 }}>
              {!publicKey ? "Connect wallet to trade" : "Perpetual futures — deposit margin, settle PnL on close"}
            </div>
          </>
        )}

        {/* Status */}
        {status && (
          <div style={{ textAlign: "center", fontSize: 11, color: "#8b949e" }}>{status}</div>
        )}
      </div>
    </div>
  );
}
