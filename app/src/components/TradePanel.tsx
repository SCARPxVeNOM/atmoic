import { useState, useMemo, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { API_BASE } from "../config";
import { usePrivySession } from "../hooks/usePrivySession";
import { useToast, Spinner } from "./Toast";
import { classifyError } from "../lib/errors";
import { useYield } from "../hooks/useYield";
import { useFundingRate } from "../hooks/useFundingRate";

const COLLATERAL = [
  { id: "SOL",  label: "SOL",  cut: 0  },
  { id: "JLP",  label: "JLP",  cut: 25 },
  { id: "mSOL", label: "mSOL", cut: 18 },
];

const LV_PRESETS = [2, 3, 5, 10];

/** Maintenance margin: 5%. Matches on-chain MAINTENANCE_MARGIN_BPS = 500. */
const MAINTENANCE_MARGIN_PCT = 0.05;

/* ── Tokens ─────────────────────────────────────────── */
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
  goldBg:    "rgba(226,184,93,0.10)",
};

const MONO = "JetBrains Mono, IBM Plex Mono, Geist Mono, monospace";
const SANS = "Inter, system-ui, sans-serif";

const labelStyle = {
  fontSize: 10, color: C.t3, textTransform: "uppercase" as const,
  letterSpacing: "0.10em", fontWeight: 500, marginBottom: 8,
};

function SummaryRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "5px 0", fontSize: 12 }}>
      <span style={{ color: C.t3, fontFamily: SANS }}>{label}</span>
      <span style={{ fontFamily: MONO, color: color || C.t1, fontFeatureSettings: "'tnum' 1" }}>{value}</span>
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
  // accentColor preserved for API compatibility but no longer used (locked palette)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  accentColor: _accentColor,
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
  const [powerMode, setPowerMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDesc, setConfirmDesc] = useState<string | null>(null);
  const toast = useToast();
  const [optimistic, setOptimistic] = useState<{ side: string; value: number } | null>(null);
  const [vaultRisk, setVaultRisk] = useState<VaultRisk | null>(null);

  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const privy = usePrivySession();

  const perpMarket = MARKET_TO_PERP[activeMarket || "SOL-USD"] || "SOL-PERP";
  const priceKey = MARKET_TO_KEY[activeMarket || "SOL-USD"] || "sol";
  const markPrice = prices?.[priceKey] || solPrice || 0;

  const yieldInfo = useYield(col);
  const funding = useFundingRate(priceKey);
  const solPriceVal = solPrice || 0;
  const sol = parseFloat(amount) || 0;
  const cut = COLLATERAL.find(c => c.id === col)?.cut || 0;

  const [collPrice, setCollPrice] = useState<number>(0);
  useEffect(() => {
    if (col === "SOL") { setCollPrice(solPriceVal); return; }
    const mint = col === "JLP"
      ? "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"
      : "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
    fetch(`https://api.jup.ag/price/v3?ids=${mint}`)
      .then(r => r.json())
      .then(d => { if (d[mint]?.usdPrice) setCollPrice(Number(d[mint].usdPrice)); })
      .catch(() => {});
  }, [col, solPriceVal]);

  const effectivePrice = col === "SOL" ? solPriceVal : collPrice;

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
    const fee = notional * 0.001;
    const entryPrice = markPrice * (side === "Long" ? 1.0003 : 0.9997);
    const marginRatio = notional > 0 ? effColl / notional : 9.99;

    const isCorrCollateral = col === "SOL" && perpMarket === "SOL-PERP";
    const liqPrice = (() => {
      if (notional <= 0 || entryPrice <= 0) return 0;
      const target = MAINTENANCE_MARGIN_PCT * notional;
      const cutFactor = (1 - cut / 100);

      if (isCorrCollateral) {
        const collSol = sol;
        if (side === "Long") {
          const denom = collSol * cutFactor + notional / entryPrice;
          return denom > 0 ? (target + notional) / denom : 0;
        } else {
          const denom = collSol * cutFactor - notional / entryPrice;
          if (denom >= 0) return 0;
          return (target - notional) / denom;
        }
      } else {
        if (side === "Long") {
          const num = (target - effColl + notional) * entryPrice;
          return num > 0 ? num / notional : 0;
        } else {
          const num = (effColl - target + notional) * entryPrice;
          return num > 0 ? num / notional : 0;
        }
      }
    })();

    const marginPct = marginRatio * 100;
    const healthCol = marginPct > 15 ? C.pos : marginPct > 8 ? C.gold : C.neg;

    return { notional, entryPrice, liqPrice, fee, marginRatio, healthCol };
  }, [sol, effectivePrice, markPrice, leverage, side, cut, col, perpMarket]);

  const sideColor = side === "Long" ? C.pos : C.neg;
  const sideBg    = side === "Long" ? C.posBg : C.negBg;
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
      for (const tx of txList) signedList.push(await signTransaction(tx));
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
    const collLabel = `${sol} ${col}`;
    const notionalUsd = summary.notional.toFixed(2);
    const marketLabel = activeMarket || "SOL-USD";
    const desc = `Open ${leverage}x ${side} ${marketLabel} — Deposit ${collLabel} ($${(sol * effectivePrice).toFixed(2)}) as margin, ${side.toLowerCase()} $${notionalUsd} notional${col !== "SOL" ? ` (auto-converts SOL → ${col})` : ""}`;
    setConfirmDesc(desc);
  };

  const executeOpen = async () => {
    if (!publicKey) return;
    setConfirmDesc(null);
    setBusy(true);
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
        power: powerMode ? 2000 : 1000,
      });
      toast.success("Position Opened", `${side} ${perpMarket} · ${sig.slice(0, 8)}…`);
      setOptimistic(null);
    } catch (e: any) {
      const err = classifyError(e);
      toast.error(err.title, err.message);
      setOptimistic(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      width: 340, flexShrink: 0,
      background: C.bg, borderLeft: `1px solid ${C.border}`,
      display: "flex", flexDirection: "column", overflowY: "auto",
      fontFamily: SANS,
    }}>
      {/* Long / Short toggle — solid fill on selected side */}
      <div style={{ display: "flex", padding: 12, gap: 8, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        {(["Long", "Short"] as const).map(s => {
          const sc   = s === "Long" ? C.pos : C.neg;
          const active = side === s;
          return (
            <button key={s} onClick={() => setSide(s)} style={{
              flex: 1, padding: "10px 0", fontSize: 13, fontWeight: 600,
              border: `1px solid ${active ? sc : C.border}`,
              borderRadius: 4,
              cursor: "pointer", letterSpacing: 0.2,
              background: active ? sc : "transparent",
              color: active ? "#000" : C.t2,
              textTransform: "uppercase",
              transition: "background 0.15s, color 0.15s, border-color 0.15s",
            }}>{s === "Long" ? "Buy" : "Sell"}</button>
          );
        })}
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Collateral chips */}
        <div>
          <div style={labelStyle}>Collateral</div>
          <div style={{ display: "flex", gap: 6 }}>
            {COLLATERAL.map(c => {
              const active = col === c.id;
              return (
                <button key={c.id} onClick={() => setCol(c.id)} style={{
                  flex: 1, padding: "9px 4px", borderRadius: 4,
                  border: `1px solid ${active ? C.borderLit : C.border}`,
                  background: active ? C.panel2 : "transparent",
                  cursor: "pointer", textAlign: "center",
                  transition: "background 0.15s, border-color 0.15s",
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: active ? C.t1 : C.t2 }}>{c.label}</div>
                  <div style={{ fontSize: 9, color: C.t3, marginTop: 3, fontFamily: MONO, letterSpacing: 0.4 }}>{c.cut}% CUT</div>
                </button>
              );
            })}
          </div>
          {col !== "SOL" && (
            <div style={{ fontSize: 10, color: C.t3, marginTop: 6, fontFamily: MONO, letterSpacing: 0.4 }}>
              AUTO-CONVERTS SOL → {col} VIA JUPITER
            </div>
          )}
        </div>

        {/* Amount input */}
        <div>
          <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span>Deposit{col !== "SOL" ? ` (${col})` : ""}</span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: C.t3, textTransform: "none" }}>
              ≈ ${(sol * effectivePrice).toFixed(2)}
            </span>
          </div>
          <div style={{
            display: "flex", alignItems: "center", background: C.panel2,
            border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 12px", gap: 8,
          }}>
            <input
              type="number" value={amount}
              onChange={e => setAmount(e.target.value)}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                fontSize: 18, fontFamily: MONO, color: C.t1, width: 0,
                fontFeatureSettings: "'tnum' 1",
              }}
            />
            <span style={{ fontSize: 12, color: C.t2, flexShrink: 0, fontWeight: 500 }}>{col}</span>
            <button onClick={async () => {
              if (!publicKey || !connection) return;
              try {
                if (col === "SOL") {
                  const bal = await connection.getBalance(publicKey);
                  const max = Math.max(0, (bal / 1e9) - 0.01);
                  setAmount(max.toFixed(4));
                } else {
                  const { PublicKey: PK } = await import("@solana/web3.js");
                  const mint = col === "JLP"
                    ? new PK("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4")
                    : new PK("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
                  const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, { mint });
                  const info = accounts.value[0]?.account?.data?.parsed?.info;
                  const bal = info ? Number(info.tokenAmount.uiAmount) : 0;
                  setAmount(bal.toFixed(col === "JLP" ? 2 : 4));
                }
              } catch { /* ignore */ }
            }} style={{
              fontSize: 10, color: C.gold, background: "transparent",
              border: `1px solid ${C.border}`, borderRadius: 3, padding: "3px 8px",
              cursor: "pointer", flexShrink: 0, fontWeight: 500, letterSpacing: 0.4,
              transition: "border-color 0.15s, color 0.15s",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.color = C.goldBright; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.gold; }}
            >MAX</button>
          </div>
        </div>

        {/* Leverage */}
        <div>
          <div style={{ ...labelStyle, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span>Leverage</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: C.t1, textTransform: "none", fontWeight: 600 }}>{leverage.toFixed(1)}×</span>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {LV_PRESETS.map(lv => {
              const active = leverage === lv;
              return (
                <button key={lv} onClick={() => setLeverage(lv)} style={{
                  flex: 1, padding: "7px 0", borderRadius: 4,
                  border: `1px solid ${active ? C.borderLit : C.border}`,
                  background: active ? C.panel2 : "transparent",
                  color: active ? C.t1 : C.t2,
                  fontSize: 12, fontWeight: 600, fontFamily: MONO,
                  cursor: "pointer", transition: "background 0.15s, border-color 0.15s, color 0.15s",
                }}>{lv}×</button>
              );
            })}
          </div>
          <input type="range" min={1} max={10} step={0.5} value={leverage}
            onChange={e => setLeverage(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: C.gold }} />
        </div>

        {/* Power Mode */}
        <button
          onClick={() => setPowerMode(v => !v)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 12px", borderRadius: 4,
            background: powerMode ? C.goldBg : C.panel2,
            border: `1px solid ${powerMode ? C.gold : C.border}`,
            cursor: "pointer", textAlign: "left", width: "100%",
            transition: "background 0.15s, border-color 0.15s",
          }}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: powerMode ? C.goldBright : C.t1, letterSpacing: 0.2 }}>
              Power Mode (×²)
            </div>
            <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>
              {powerMode ? "Convex payoff: amplified gains & losses" : "Options-like exposure without expiry"}
            </div>
          </div>
          <div style={{
            width: 34, height: 18, borderRadius: 9, position: "relative",
            background: powerMode ? C.gold : C.border, transition: "background 0.15s",
            flexShrink: 0,
          }}>
            <div style={{
              width: 14, height: 14, borderRadius: 7, background: powerMode ? "#000" : C.t2,
              position: "absolute", top: 2,
              left: powerMode ? 18 : 2, transition: "left 0.15s, background 0.15s",
            }} />
          </div>
        </button>
        {powerMode && (
          <div style={{
            fontSize: 10.5, color: C.gold, padding: "8px 10px",
            background: C.panel2, borderRadius: 4, border: `1px solid ${C.border}`,
            lineHeight: 1.45,
          }}>
            2× spread fee applies. If SOL +10%: standard +10%, power +21%.
            {leverage > 5 && " Max 5× leverage recommended for power perps."}
          </div>
        )}

        {/* Pro mode: Vault risk info */}
        {showProData && vaultRisk && (
          <div style={{
            display: "flex", gap: 10, fontSize: 11,
            background: C.panel2, borderRadius: 4, padding: "8px 12px",
            border: `1px solid ${C.border}`, alignItems: "baseline",
          }}>
            <span style={{ color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9 }}>Spread</span>
            <span style={{ fontFamily: MONO, color: vaultRisk.suspended ? C.neg : C.t1 }}>
              {vaultRisk.suspended ? "SUSPENDED" : `${vaultRisk.spreadBps} bps`}
            </span>
            <span style={{ color: C.t3 }}>·</span>
            <span style={{ color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9 }}>Skew</span>
            <span style={{ fontFamily: MONO, color: C.t1 }}>{vaultRisk.skewPct}%</span>
          </div>
        )}

        {/* Order summary */}
        <div style={{ background: C.panel2, borderRadius: 4, padding: "12px 14px", border: `1px solid ${C.border}` }}>
          <div style={{ ...labelStyle, marginBottom: 8 }}>Order Summary</div>
          <div style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 8 }}>
            <SummaryRow label="Margin"        value={`$${(sol * effectivePrice).toFixed(2)}`} />
            <SummaryRow label="Position Size" value={`$${summary.notional.toFixed(2)}`} />
            <SummaryRow label="Entry Price"   value={`$${summary.entryPrice.toFixed(2)}`} />
            <SummaryRow label="Liq. Price"    value={`$${summary.liqPrice.toFixed(2)}`} color={C.neg} />
            <SummaryRow label="Spread"        value={vaultRisk ? `${vaultRisk.spreadBps} bps` : "5 bps"} />
            <SummaryRow label="Fee (10 bps)"  value={`$${summary.fee.toFixed(3)}`} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, alignItems: "baseline" }}>
            <span style={{ color: C.t2 }}>Margin Ratio</span>
            <span style={{ fontFamily: MONO, fontWeight: 600, color: summary.healthCol, fontFeatureSettings: "'tnum' 1" }}>
              {(summary.marginRatio * 100).toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Yield vs Funding breakdown — JLP/mSOL only */}
        {col !== "SOL" && (funding || yieldInfo) && (
          (() => {
            const fundRate8h = funding?.rate8h ?? 0;
            const yieldRate8h = yieldInfo?.rate8h ?? 0;
            const net = fundRate8h - yieldRate8h;
            const isSelfRepaying = net < 0;
            const netColor = isSelfRepaying ? C.pos : net === 0 ? C.t1 : C.neg;
            return (
              <div style={{ background: C.panel2, borderRadius: 4, padding: "12px 14px", border: `1px solid ${C.border}` }}>
                <div style={{ ...labelStyle, marginBottom: 8 }}>Yield vs Funding</div>
                <SummaryRow label="Funding Rate"      value={`${fundRate8h >= 0 ? "+" : ""}${fundRate8h.toFixed(4)}% / 8h`} color={fundRate8h >= 0 ? C.neg : C.pos} />
                <SummaryRow label={`${col} Yield`}    value={`−${yieldRate8h.toFixed(4)}% / 8h`} color={C.pos} />
                <div style={{ borderTop: `1px solid ${C.border}`, margin: "6px 0" }} />
                <SummaryRow label="Net Carry"         value={`${net >= 0 ? "+" : ""}${net.toFixed(4)}% / 8h`} color={netColor} />
                {isSelfRepaying && (
                  <div style={{
                    marginTop: 6, padding: "4px 8px", borderRadius: 4,
                    background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)",
                    fontSize: 10, fontWeight: 600, color: C.pos, textAlign: "center",
                    letterSpacing: 0.5, textTransform: "uppercase",
                  }}>
                    Self-Repaying
                  </div>
                )}
              </div>
            );
          })()
        )}

        {/* Confirmation modal */}
        {confirmDesc && (
          <div style={{
            background: C.panel2, borderRadius: 4, padding: 14,
            border: `1px solid ${C.borderLit}`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.t1, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>Confirm Transaction</div>
            <div style={{ fontSize: 12, color: C.t2, marginBottom: 12, lineHeight: 1.5 }}>{confirmDesc}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={executeOpen} style={{
                flex: 1, padding: "10px 0", borderRadius: 4, border: 0,
                background: sideColor, color: "#000", fontSize: 12.5,
                fontWeight: 600, cursor: "pointer", letterSpacing: 0.2,
              }}>Confirm</button>
              <button onClick={() => setConfirmDesc(null)} style={{
                flex: 1, padding: "10px 0", borderRadius: 4,
                border: `1px solid ${C.border}`, background: "transparent",
                color: C.t2, fontSize: 12.5, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Optimistic confirmation */}
        {optimistic && !confirmDesc && (
          <div style={{
            background: C.panel2, borderRadius: 4, padding: 14,
            border: `1px solid ${C.border}`, textAlign: "center",
          }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%", background: C.gold,
              margin: "0 auto 8px", animation: "pulse 1.5s infinite",
            }} />
            <div style={{ fontSize: 11, color: C.gold, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>
              Confirming on Solana…
            </div>
            <div style={{ fontSize: 12, fontFamily: MONO, color: C.t1 }}>
              {optimistic.side} ${optimistic.value.toFixed(2)}
            </div>
            <div style={{ fontSize: 10.5, color: C.t3, marginTop: 4 }}>
              Transaction sent — waiting for block confirmation
            </div>
          </div>
        )}

        {/* Privy session key toggle */}
        {privy.enabled && publicKey && !confirmDesc && !optimistic && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 12px", background: C.panel2, borderRadius: 4,
            border: `1px solid ${C.border}`, fontSize: 11,
          }}>
            <div>
              <span style={{ color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9, marginRight: 6 }}>Session Key</span>
              {privy.session?.active ? (
                <span style={{ color: C.pos, fontWeight: 600, fontFamily: MONO }}>
                  Active · {privy.remainingCap.toFixed(2)} SOL
                </span>
              ) : (
                <span style={{ color: C.t3 }}>Off</span>
              )}
            </div>
            <button
              onClick={() => privy.session?.active ? privy.endSession() : privy.startSession(1.0)}
              style={{
                padding: "3px 10px", borderRadius: 3, border: `1px solid ${C.border}`,
                background: "transparent", cursor: "pointer", fontSize: 11,
                color: privy.session?.active ? C.neg : C.gold, letterSpacing: 0.4,
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
                width: "100%", padding: "13px 0", borderRadius: 4, border: 0,
                background: btnDisabled ? C.panel2 : sideColor,
                color: btnDisabled ? C.t3 : "#000",
                fontSize: 13.5, fontWeight: 600, cursor: btnDisabled ? "not-allowed" : "pointer",
                letterSpacing: 0.4, textTransform: "uppercase",
                transition: "opacity 0.15s",
              }}>
              {busy
                ? <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <Spinner size={13} color={btnDisabled ? C.t3 : "#000"} />
                    Confirming…
                  </span>
                : `${side === "Long" ? "Buy" : "Sell"} ${perpMarket}`}
            </button>
            <div style={{ textAlign: "center", fontSize: 10.5, color: C.t3, marginTop: -6, lineHeight: 1.5 }}>
              {!publicKey ? "Connect wallet to trade" : "Perpetual futures · settles on close"}
            </div>
          </>
        )}


        {/* Subtle gap reference visualization for sideBg (kept since logic-equivalent) */}
        <div style={{ display: "none", background: sideBg }} />
      </div>
    </div>
  );
}
