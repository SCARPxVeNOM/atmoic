import { useState, useEffect, useRef, useMemo, FC, CSSProperties } from "react";

/* ─── TOKENS ─────────────────────────────────────────────────────────── */
const C = {
  bg:     "#000000",
  surf2:  "#111114",
  bdr:    "#1A1A1F",
  bdrLit: "#26262E",
  t1:     "#E5E5E7",
  t2:     "#8B8B94",
  t3:     "#4A4A52",
  pos:    "#22C55E",
  posBg:  "rgba(34,197,94,0.08)",
  neg:    "#EF4444",
  negBg:  "rgba(239,68,68,0.08)",
  warn:   "#F59E0B",
  warnBg: "rgba(245,158,11,0.08)",
};

const MONO = "'JetBrains Mono', monospace";
const SANS = "'Inter', sans-serif";
const LOOP_MS = 13500;

/* ─── HELPERS ─────────────────────────────────────────────────────────── */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp  = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);
const inv   = (a: number, b: number, v: number) => clamp((v - a) / (b - a), 0, 1);
const eOut  = (t: number) => 1 - Math.pow(1 - t, 3);
const tween = (a: number, b: number, t0: number, t1: number, now: number) => lerp(a, b, eOut(inv(t0, t1, now)));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
}

interface Candle { open: number; close: number; hi: number; lo: number; up: boolean; }

function makeCandles(n: number, base: number, vol: number, seed: number): Candle[] {
  const r = rng(seed);
  let price = base;
  return Array.from({ length: n }, () => {
    const d = (r() - 0.5) * vol;
    const open = price;
    price = clamp(price + d, base - vol * 3, base + vol * 3);
    const close = price;
    const hi = Math.max(open, close) + r() * vol * 0.4;
    const lo = Math.min(open, close) - r() * vol * 0.4;
    return { open, close, hi, lo, up: close >= open };
  });
}

const BASE_CANDLES = makeCandles(27, 182, 1.1, 77);

const WICK_DN: Candle[] = [
  { open: 182.34, close: 176.10, hi: 182.70, lo: 175.70, up: false },
  { open: 176.10, close: 170.40, hi: 176.50, lo: 170.00, up: false },
  { open: 170.40, close: 165.20, hi: 170.70, lo: 164.80, up: false },
];
const WICK_UP: Candle[] = [
  { open: 165.20, close: 172.10, hi: 172.50, lo: 164.80, up: true  },
  { open: 172.10, close: 178.40, hi: 178.80, lo: 171.80, up: true  },
  { open: 178.40, close: 181.80, hi: 182.20, lo: 178.00, up: true  },
];

const OB = [
  { px: "182.50", sz: "12.4", ask: true  },
  { px: "182.34", sz: "8.1",  ask: true  },
  { px: "182.18", sz: "23.7", ask: true  },
  { px: "182.02", sz: "5.2",  ask: true  },
  { px: "181.90", sz: "31.0", ask: false },
  { px: "181.74", sz: "18.6", ask: false },
  { px: "181.58", sz: "9.3",  ask: false },
  { px: "181.40", sz: "44.2", ask: false },
];

const fmt2    = (v: number) => v.toFixed(2);
const fmtUSD  = (v: number) =>
  v >= 1000 ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toFixed(2);
const fmtSign = (v: number) => (v >= 0 ? "+" : "") + fmt2(v);
const marginCol = (m: number) => (m > 8 ? C.pos : m > 3.5 ? C.warn : C.neg);

/* ─── CANDLE CHART ────────────────────────────────────────────────────── */
const CandleChart: FC<{ wickPhase: number; dim?: boolean }> = ({ wickPhase, dim = false }) => {
  const W = 490, H = 300;
  const candles: Candle[] = [...BASE_CANDLES];
  const nDn = wickPhase >= 3 ? 3 : wickPhase >= 2 ? 2 : wickPhase >= 1 ? 1 : 0;
  const nUp = wickPhase >= 6 ? 3 : wickPhase >= 5 ? 2 : wickPhase >= 4 ? 1 : 0;
  for (let i = 0; i < nDn; i++) candles.push(WICK_DN[i]);
  if (nDn === 3) for (let i = 0; i < nUp; i++) candles.push(WICK_UP[i]);

  const lows  = candles.map(c => c.lo);
  const highs = candles.map(c => c.hi);
  const minP = Math.min(...lows) - 1;
  const maxP = Math.max(...highs) + 1;
  const span = maxP - minP;

  const py = (p: number) => H - ((p - minP) / span) * H;
  const cw = W / candles.length;
  const liqY = py(165.0);

  return (
    <svg width={W} height={H} style={{ position: "absolute", top: 0, left: 0, opacity: dim ? 0.10 : 0.16, pointerEvents: "none" }}>
      {candles.map((c, i) => {
        const x  = i * cw + cw / 2;
        const oY = py(c.open), cY = py(c.close);
        const hY = py(c.hi),   lY = py(c.lo);
        const bH = Math.max(1, Math.abs(oY - cY));
        const col = c.up ? C.pos : C.neg;
        return (
          <g key={i}>
            <line x1={x} y1={hY} x2={x} y2={lY} stroke={col} strokeWidth={0.6} />
            <rect x={x - cw * 0.32} y={Math.min(oY, cY)} width={cw * 0.64} height={bH} fill={col} />
          </g>
        );
      })}
      <line x1={0} y1={liqY} x2={W} y2={liqY} stroke={C.neg} strokeWidth={0.5} strokeDasharray="4 3" opacity={0.35} />
      <text x={W - 3} y={liqY - 3} fill={C.neg} fontSize={7} textAnchor="end" fontFamily={MONO} opacity={0.45}>
        LIQ 165.00
      </text>
    </svg>
  );
};

/* ─── ORDER BOOK ──────────────────────────────────────────────────────── */
const OrderBook: FC = () => (
  <div style={{ position: "absolute", right: 0, top: 0, bottom: 20, width: 76, opacity: 0.38, display: "flex", flexDirection: "column", justifyContent: "center", paddingRight: 4 }}>
    {OB.map((r, i) => (
      <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "1.5px 5px", borderLeft: `2px solid ${r.ask ? C.neg : C.pos}18` }}>
        <span style={{ fontFamily: MONO, fontSize: 8, color: r.ask ? C.neg : C.pos }}>{r.px}</span>
        <span style={{ fontFamily: MONO, fontSize: 8, color: C.t3 }}>{r.sz}</span>
      </div>
    ))}
  </div>
);

const StatusBar: FC<{ block: number }> = ({ block }) => (
  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 18, borderTop: `1px solid ${C.bdr}`, display: "flex", alignItems: "center", paddingLeft: 10, opacity: 0.12 }}>
    <span style={{ fontFamily: MONO, fontSize: 8, color: C.t2, letterSpacing: "0.04em" }}>
      MAINNET · PROGRAM 8s67…cDWg · BLOCK #{(312847221 + block).toLocaleString()}
    </span>
  </div>
);

const TierLadder: FC<{ level: number }> = ({ level }) => {
  const tiers = [
    { id: 1, label: "T1", action: "25%"  },
    { id: 2, label: "T2", action: "50%"  },
    { id: 3, label: "T3", action: "75%"  },
    { id: 4, label: "T4", action: "100%" },
  ];
  return (
    <div style={{ width: 58, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontFamily: MONO, fontSize: 7, color: C.t3, letterSpacing: "0.06em", paddingBottom: 2, textAlign: "center" }}>TIERS</div>
      {tiers.map(t => {
        const active = level >= t.id;
        const isT4   = t.id === 4;
        const col    = isT4 ? C.neg : C.warn;
        return (
          <div key={t.id} style={{
            height: 30,
            border: `1px solid ${active ? col : C.bdr}`,
            borderRadius: 3,
            background: active ? (isT4 ? C.negBg : C.warnBg) : "transparent",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
            opacity: active ? 1 : 0.45,
            transition: "background 0.3s, border-color 0.3s, opacity 0.3s",
          }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: active ? col : C.t3, fontWeight: 500, transition: "color 0.3s" }}>{t.label}</span>
            <span style={{ fontFamily: MONO, fontSize: 7, color: C.t3 }}>{t.action}</span>
          </div>
        );
      })}
    </div>
  );
};

interface RowProps {
  label: string; value: string; color?: string;
  strikethrough?: boolean; dim?: boolean; compact?: boolean;
}

const Row: FC<RowProps> = ({ label, value, color, strikethrough, dim, compact }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: compact ? "1.5px 0" : "2.5px 0", minHeight: compact ? 16 : 19, gap: 6 }}>
    <span style={{ fontFamily: SANS, fontSize: compact ? 9 : 10, color: C.t3, letterSpacing: "0.06em", flexShrink: 0, whiteSpace: "nowrap" }}>{label}</span>
    <span style={{
      fontFamily: MONO, fontSize: compact ? 10 : 11, fontFeatureSettings: "'tnum' 1",
      color: dim ? C.t3 : (color || C.t1),
      textDecoration: strikethrough ? `line-through ${C.neg}` : "none",
      transition: "color 0.3s",
      whiteSpace: "nowrap",
      textAlign: "right",
    } as CSSProperties}>{value}</span>
  </div>
);

/* ─── MAIN ────────────────────────────────────────────────────────────── */
export const GradualDeleverage: FC = () => {
  const [ms, setMs] = useState(0);
  const [block, setBlock] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef   = useRef<number>(0);

  useEffect(() => {
    const tick = (ts: number) => {
      if (!startRef.current) startRef.current = ts;
      setMs((ts - startRef.current) % LOOP_MS);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setBlock(b => b + 1), 400);
    return () => window.clearInterval(id);
  }, []);

  const t = ms;

  const mark = useMemo(() => {
    if (t < 2100) return 182.34 + Math.sin(t * 0.006) * 0.04;
    if (t < 2460) return tween(182.34, 176.10, 2100, 2460, t);
    if (t < 2850) return tween(176.10, 170.40, 2460, 2850, t);
    if (t < 3300) return tween(170.40, 165.20, 2850, 3300, t);
    if (t < 5100) return 165.20;
    if (t < 5475) return tween(165.20, 172.10, 5100, 5475, t);
    if (t < 5850) return tween(172.10, 178.40, 5475, 5850, t);
    if (t < 6300) return tween(178.40, 181.80, 5850, 6300, t);
    return 181.80 + Math.sin(t * 0.005) * 0.05;
  }, [t]);

  const wickPhase = useMemo(() => {
    if (t < 2460) return 0;
    if (t < 2850) return 1;
    if (t < 3300) return 2;
    if (t < 5100) return 3;
    if (t < 5475) return 4;
    if (t < 5850) return 5;
    return 6;
  }, [t]);

  const leftMargin = useMemo(() => {
    if (t < 2100) return 20.04;
    if (t < 2460) return tween(20.04, 10.2, 2100, 2460, t);
    if (t < 2850) return tween(10.2, 4.8, 2460, 2850, t);
    if (t < 3300) return tween(4.8, 1.9, 2850, 3300, t);
    return 1.9;
  }, [t]);

  const leftUnrealized = useMemo(() => {
    if (t < 2100) return 21.06;
    if (t < 3300) return tween(21.06, -350, 2100, 3300, t);
    return -350;
  }, [t]);

  const leftLiquid = t >= 3600 && t < 13050;
  const leftSweep  = t >= 3300 && t < 3900;

  const rightTierActive = useMemo(() => {
    if (t < 2460) return 0;
    if (t < 2850) return 1;
    if (t < 3300) return 2;
    if (t < 5100) return 3;
    if (t < 5700) return 2;
    if (t < 6300) return 1;
    return 0;
  }, [t]);

  const rightSize = useMemo(() => {
    if (t < 2460) return 50000;
    if (t < 2850) return tween(50000, 37500, 2460, 2730, t);
    if (t < 3300) return tween(37500, 18750, 2850, 3090, t);
    if (t < 3750) return tween(18750, 4687.5, 3300, 3630, t);
    return 4687.5;
  }, [t]);

  const rightCollat = useMemo(() => {
    if (t < 2460) return 10000;
    if (t < 3750) return tween(10000, 8900, 2460, 3630, t);
    return 8900;
  }, [t]);

  const rightMargin = useMemo(() => {
    if (t < 2100) return 20.04;
    if (t < 2460) return tween(20.04, 10.2, 2100, 2460, t);
    if (t < 3750) return tween(10.2, 4.5, 2460, 3750, t);
    if (t < 5100) return 4.5;
    if (t < 6450) return tween(4.5, 14.6, 5100, 6450, t);
    return 14.6 + Math.sin(t * 0.004) * 0.3;
  }, [t]);

  const rightUnrealized = useMemo(() => {
    if (t < 2100) return 21.06;
    if (t < 3750) return tween(21.06, -85, 2100, 3750, t);
    if (t < 5100) return -85;
    if (t < 6450) return tween(-85, 25.4, 5100, 6450, t);
    return 25.4;
  }, [t]);

  const toast = useMemo(() => {
    if (t >= 2460 && t < 2850) return { key: "t1", msg: "◎ TIER 1 · CLOSING 25%   −12,500 USD notional" };
    if (t >= 2850 && t < 3300) return { key: "t2", msg: "◎ TIER 2 · CLOSING 50%   −18,750 USD notional" };
    if (t >= 3300 && t < 5100) return { key: "t3", msg: "◎ TIER 3 · CLOSING 75%   −9,375 USD notional"  };
    return null;
  }, [t]);

  const showCenterLabel = t >= 750  && t < 13050;
  const showEpitaph     = t >= 7500 && t < 13050;
  const showComparison  = t >= 8400 && t < 13050;
  const showCaption     = t >= 11100 && t < 13500;
  const globalOpacity   = t >= 12900 ? lerp(1, 0, inv(12900, 13500, t)) : 1;

  return (
    <div className="gradual-deleverage" style={{
      width: "100%",
      maxWidth: 1200,
      aspectRatio: "5 / 2",
      background: C.bg,
      border: `1px solid ${C.bdr}`,
      borderRadius: 8,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      opacity: globalOpacity,
      fontFamily: SANS,
      position: "relative",
    } as CSSProperties}>

      <div style={{ display: "flex", borderBottom: `1px solid ${C.bdr}`, height: 38, flexShrink: 0 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", borderRight: `1px solid ${C.bdr}`, gap: 8, minWidth: 0 }}>
          <span style={{ fontFamily: SANS, fontSize: 11, fontWeight: 600, color: C.t1, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>STANDARD PROTOCOL</span>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.t3, letterSpacing: "0.07em", whiteSpace: "nowrap" }}>02 / BINARY LIQUIDATION</span>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", gap: 8, minWidth: 0 }}>
          <span style={{ fontFamily: SANS, fontSize: 11, fontWeight: 600, color: C.t1, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>IDLEXCHANGE</span>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.t3, letterSpacing: "0.07em", whiteSpace: "nowrap" }}>02 / GRADUAL DELEVERAGE</span>
        </div>
      </div>

      <div style={{
        position: "absolute", top: 40, left: "50%", transform: "translateX(-50%)",
        zIndex: 20, pointerEvents: "none",
        opacity: showCenterLabel ? 1 : 0,
        transition: "opacity 0.4s",
      }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.t3, letterSpacing: "0.07em" }}>BINANCE-SOL · 14:32:08 UTC</span>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>

        <div style={{ flex: 1, position: "relative", borderRight: `1px solid ${C.bdr}`, overflow: "hidden" }}>
          <CandleChart wickPhase={wickPhase} dim={leftLiquid} />
          <OrderBook />

          <div style={{
            position: "absolute",
            top: "30%", left: 10, right: 88,
            border: `1px solid ${leftLiquid ? "rgba(239,68,68,0.4)" : C.bdrLit}`,
            borderRadius: 6,
            background: leftLiquid ? C.negBg : C.surf2,
            padding: "8px 10px",
            opacity: leftLiquid ? 0.55 : 1,
            transition: "border-color 0.24s, opacity 0.5s, background 0.24s",
            zIndex: 2,
          }}>
            {leftSweep && (
              <div className="gradual-sweep" style={{
                position: "absolute", left: 0, right: 0, height: 1,
                background: C.neg, zIndex: 10,
              }} />
            )}
            {leftLiquid && (
              <div style={{
                position: "absolute", top: 8, right: 8,
                background: "rgba(239,68,68,0.15)", border: `1px solid rgba(239,68,68,0.4)`,
                borderRadius: 3, padding: "2px 6px",
              }}>
                <span style={{ fontFamily: MONO, fontSize: 8, color: C.neg, letterSpacing: "0.08em" }}>POSITION CLOSED</span>
              </div>
            )}

            <Row compact label="POSITION"   value="LONG · 5×"   strikethrough={leftLiquid} dim={leftLiquid} />
            <Row compact label="MARKET"     value="SOL-PERP"    dim={leftLiquid} />
            <Row compact label="ENTRY"      value="181.92"      dim={leftLiquid} />
            <Row compact label="MARK"       value={fmt2(mark)}  dim={leftLiquid} />
            <Row compact label="SIZE"       value={leftLiquid ? "0.00" : "50,000 USD"}      strikethrough={leftLiquid} dim={leftLiquid} />
            <Row compact label="COLLAT."    value={leftLiquid ? "0.00" : "10,000.00 USDC"}  strikethrough={leftLiquid} dim={leftLiquid} />
            <Row
              compact label="UNRLZD"
              value={leftLiquid ? "—" : fmtSign(leftUnrealized)}
              color={leftLiquid ? C.t3 : (leftUnrealized >= 0 ? C.pos : C.neg)}
              dim={leftLiquid}
            />
            <div style={{ borderTop: `1px solid ${C.bdr}`, margin: "2px 0" }} />
            <Row
              compact label="MARGIN"
              value={leftLiquid ? "—" : fmt2(leftMargin) + "%"}
              color={leftLiquid ? C.t3 : marginCol(leftMargin)}
              dim={leftLiquid}
            />
            <Row compact label="LIQ. PRICE" value="—" dim />

            {leftLiquid && (
              <div style={{
                borderTop: `1px solid rgba(239,68,68,0.3)`, marginTop: 4, paddingTop: 4,
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <span style={{ fontFamily: SANS, fontSize: 9, color: C.t3, letterSpacing: "0.06em", flexShrink: 0 }}>LIQUIDATED</span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.neg, fontFeatureSettings: "'tnum' 1", whiteSpace: "nowrap" } as CSSProperties}>
                  −10,000.00 USDC + 5% penalty
                </span>
              </div>
            )}
          </div>

          <div style={{
            position: "absolute", bottom: 24, left: 10,
            opacity: showEpitaph ? 1 : 0,
            transition: "opacity 0.5s",
          }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: C.t2, letterSpacing: "0.06em" }}>
              PRICE RECOVERED. POSITION DID NOT.
            </span>
          </div>

          <StatusBar block={block} />
        </div>

        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <CandleChart wickPhase={wickPhase} />
          <OrderBook />

          <div style={{
            position: "absolute",
            top: "30%", left: 10, right: 82,
            display: "flex", gap: 6, zIndex: 2,
          }}>
            <TierLadder level={rightTierActive} />

            <div style={{
              flex: 1, minWidth: 0,
              border: `1px solid ${C.bdrLit}`,
              borderRadius: 6,
              background: C.surf2,
              padding: "8px 10px",
            }}>
              <Row compact label="POSITION"   value="LONG · 5×" />
              <Row compact label="MARKET"     value="SOL-PERP" />
              <Row compact label="ENTRY"      value="181.92" />
              <Row compact label="MARK"       value={fmt2(mark)} />
              <Row compact label="SIZE"       value={fmtUSD(rightSize) + " USD"} />
              <Row compact label="COLLAT."    value={fmtUSD(rightCollat) + " USDC"} />
              <Row
                compact label="UNRLZD"
                value={fmtSign(rightUnrealized)}
                color={rightUnrealized >= 0 ? C.pos : C.neg}
              />
              <div style={{ borderTop: `1px solid ${C.bdr}`, margin: "2px 0" }} />
              <Row
                compact label="MARGIN"
                value={fmt2(rightMargin) + "%"}
                color={marginCol(rightMargin)}
              />
              <Row compact label="LIQ. PRICE" value="—" dim />

              <div style={{
                marginTop: 4,
                borderTop: `1px solid rgba(245,158,11,0.25)`,
                paddingTop: 4,
                minHeight: 20,
                opacity: toast ? 1 : 0,
                transition: "opacity 0.2s",
              }}>
                {toast && (
                  <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.warn, letterSpacing: "0.03em", whiteSpace: "nowrap" }}>
                    {toast.msg}
                  </span>
                )}
              </div>
            </div>
          </div>

          <StatusBar block={block} />
        </div>
      </div>

      <div style={{
        borderTop: `1px solid ${C.bdrLit}`,
        display: "flex",
        flexShrink: 0,
        height: 46,
        overflow: "hidden",
        opacity: showComparison ? 1 : 0,
        transition: "opacity 0.4s",
      }}>
        <div style={{ flex: 1, padding: "7px 14px", borderRight: `1px solid ${C.bdr}`, display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontFamily: SANS, fontSize: 9, color: C.t3, letterSpacing: "0.07em", marginBottom: 2 }}>NET RESULT</div>
            <div style={{ fontFamily: MONO, fontSize: 12, color: C.neg, fontFeatureSettings: "'tnum' 1", whiteSpace: "nowrap" } as CSSProperties}>−10,500.00 USDC</div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontFamily: SANS, fontSize: 9, color: C.t3, letterSpacing: "0.07em", marginBottom: 2 }}>POSITION RECOVERED</div>
            <div style={{ fontFamily: MONO, fontSize: 12, color: C.t3, fontFeatureSettings: "'tnum' 1", whiteSpace: "nowrap" } as CSSProperties}>0%</div>
          </div>
        </div>
        <div style={{ flex: 1, padding: "7px 14px", display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontFamily: SANS, fontSize: 9, color: C.t3, letterSpacing: "0.07em", marginBottom: 2 }}>NET RESULT</div>
            <div style={{ fontFamily: MONO, fontSize: 12, color: C.warn, fontFeatureSettings: "'tnum' 1", whiteSpace: "nowrap" } as CSSProperties}>−380.00 USDC</div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontFamily: SANS, fontSize: 9, color: C.t3, letterSpacing: "0.07em", marginBottom: 2, whiteSpace: "nowrap" }}>POSITION RECOVERED</div>
            <div style={{
              fontFamily: MONO, fontSize: 12, fontFeatureSettings: "'tnum' 1",
              color: t >= 9600 ? C.pos : C.t3,
              transition: "color 0.5s",
              whiteSpace: "nowrap",
            } as CSSProperties}>
              {t >= 9600 ? "25% RIDING RECOVERY" : "—"}
            </div>
          </div>
        </div>
      </div>

      <div style={{
        borderTop: `1px solid ${C.bdr}`,
        padding: "7px 14px",
        flexShrink: 0,
        height: 46,
        overflow: "hidden",
        opacity: showCaption ? 1 : 0,
        transition: "opacity 0.35s",
      }}>
        <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.t1, letterSpacing: "-0.01em", marginBottom: 3 }}>
          A WICK SHOULD NOT VAPORIZE A HEALTHY POSITION.
        </div>
        <div style={{ fontFamily: SANS, fontSize: 11, color: C.t3 }}>
          Gradual deleveraging. Tiered, on-chain, proven.
        </div>
      </div>
    </div>
  );
};
