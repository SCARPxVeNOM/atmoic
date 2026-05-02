import { useState, useEffect, useRef, useCallback, FC, ReactNode, CSSProperties } from "react";

const C = {
  bg:        "#000",
  surface:   "#0A0A0B",
  surface2:  "#111114",
  border:    "#1A1A1F",
  borderLit: "#26262E",
  t1:        "#E5E5E7",
  t2:        "#8B8B94",
  t3:        "#4A4A52",
  pos:       "#22C55E",
  posBg:     "rgba(34,197,94,0.08)",
  posBdr:    "rgba(34,197,94,0.3)",
  neg:       "#EF4444",
  accent:    "#A78BFA",
};

/* ── Candlesticks (set dressing) ──────────────────────────── */
const Candlesticks: FC = () => {
  const raw: [number, number, number, number][] = [
    [182.1,183.2,181.4,182.8],[182.8,183.5,182.3,183.1],[183.1,183.8,182.6,182.4],
    [182.4,183.0,181.8,182.9],[182.9,184.1,182.5,183.6],[183.6,184.4,183.0,183.2],
    [183.2,183.7,182.2,182.6],[182.6,183.1,181.9,182.1],[182.1,182.8,181.5,182.7],
    [182.7,183.4,182.1,183.0],[183.0,183.9,182.6,182.5],[182.5,183.2,182.0,183.3],
    [183.3,184.0,182.8,183.8],[183.8,184.5,183.2,183.4],[183.4,184.2,182.9,182.8],
    [182.8,183.5,182.1,183.1],[183.1,183.8,182.4,182.6],[182.6,183.3,181.8,183.5],
    [183.5,184.3,183.0,184.0],[184.0,184.8,183.5,183.7],[183.7,184.4,183.1,183.2],
    [183.2,183.9,182.7,183.6],[183.6,184.2,183.0,183.9],[183.9,184.6,183.3,183.4],
    [183.4,184.1,182.8,184.2],[184.2,185.0,183.8,184.6],[184.6,185.3,184.1,184.1],
    [184.1,184.8,183.5,184.5],[184.5,185.2,184.0,184.8],[184.8,185.5,184.3,185.0],
  ];
  const minP = 178, maxP = 186, rangeP = maxP - minP;
  const W = 420, H = 72, cW = 9, gap = 5, tot = cW + gap;
  const y = (p: number) => H - ((p - minP) / rangeP) * H;
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
      style={{ position: "absolute", inset: 0, opacity: 0.18, pointerEvents: "none", zIndex: 0 }}>
      {raw.map(([o, h, l, c], i) => {
        const bull = c >= o;
        const col = bull ? C.pos : C.neg;
        const bTop = Math.min(y(o), y(c));
        const bH = Math.max(Math.abs(y(o) - y(c)), 1);
        const x = i * tot + 2;
        return (
          <g key={i}>
            <line x1={x + cW / 2} y1={y(h)} x2={x + cW / 2} y2={y(l)} stroke={col} strokeWidth="0.8" />
            <rect x={x} y={bTop} width={cW} height={bH} fill={col} opacity={0.7} />
          </g>
        );
      })}
    </svg>
  );
};

const OrderBook: FC = () => {
  const asks: [number, number][] = [[183.20,1240],[183.05,890],[182.90,2100],[182.75,430]];
  const bids: [number, number][] = [[182.20,1670],[182.05,3420],[181.90,980],[181.75,590]];
  return (
    <div style={{
      position: "absolute", top: 36, right: 0, width: 106,
      fontFamily: "JetBrains Mono,monospace", fontSize: 9,
      opacity: 0.4, pointerEvents: "none", zIndex: 1, lineHeight: "15px",
    }}>
      {asks.map(([p, s], i) => (
        <div key={`a${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
          <span style={{ color: C.neg }}>{p.toFixed(2)}</span>
          <span style={{ color: C.t3 }}>{s.toLocaleString()}</span>
        </div>
      ))}
      <div style={{
        color: C.t2, textAlign: "center",
        borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
        padding: "1px 0", margin: "2px 0", fontSize: 9,
      }}>182.34</div>
      {bids.map(([p, s], i) => (
        <div key={`b${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
          <span style={{ color: C.pos }}>{p.toFixed(2)}</span>
          <span style={{ color: C.t3 }}>{s.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

const Sparkline: FC<{ points: number[]; color: string; label: string; valueNode: ReactNode }> = ({ points, color, label, valueNode }) => {
  const W = 300, H = 34;
  const minV = Math.min(...points);
  const maxV = Math.max(...points);
  const rng = Math.max(maxV - minV, 2);
  const tx = (i: number) => (i / (points.length - 1)) * W;
  const ty = (v: number) => H - ((v - minV) / rng) * (H - 4) - 2;
  const path = points.map((v, i) => `${i === 0 ? "M" : "L"}${tx(i)},${ty(v)}`).join(" ");
  const area = path + ` L${W},${H} L0,${H} Z`;
  const gradId = `sg-${color.replace("#", "")}`;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
        <span style={{ fontFamily: "Inter,sans-serif", fontSize: 10, fontWeight: 500, color: C.t3, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
        {valueNode}
      </div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradId})`} opacity={0.1} />
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" opacity={0.75} />
      </svg>
    </div>
  );
};

const AnimNum: FC<{ target: number; decimals?: number; color: string }> = ({ target, decimals = 2, color }) => {
  const [val, setVal] = useState(target);
  const prev = useRef(target);
  const raf  = useRef<number | null>(null);

  useEffect(() => {
    const from = prev.current, to = target;
    if (from === to) return;
    const start = performance.now(), dur = 900;
    const step = (now: number) => {
      const t = Math.min((now - start) / dur, 1);
      const e = 1 - Math.pow(1 - t, 3);
      setVal(from + (to - from) * e);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else { setVal(to); prev.current = to; }
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target]);

  const str = val.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <span style={{ color, fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontFeatureSettings: "'tnum' 1", fontVariantNumeric: "tabular-nums" } as CSSProperties}>{str}</span>;
};

interface DRowProps { label: string; value: ReactNode; col?: string; italic?: boolean; bold?: boolean; }
const DRow: FC<DRowProps> = ({ label, value, col, italic, bold }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0", borderBottom: `1px solid ${C.border}` }}>
    <span style={{ fontFamily: "Inter,sans-serif", fontSize: 10, fontWeight: 500, color: C.t3, letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</span>
    <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: bold ? 13 : 11, fontWeight: bold ? 500 : 400, fontFeatureSettings: "'tnum' 1", color: col || C.t1, fontStyle: italic ? "italic" : "normal" } as CSSProperties}>{value}</span>
  </div>
);

const StatusBar: FC<{ block: number }> = ({ block }) => (
  <div style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 9, color: C.t2, opacity: 0.12, marginTop: 8, borderTop: `1px solid ${C.border}`, paddingTop: 4, letterSpacing: "0.02em", userSelect: "none" }}>
    MAINNET · PROGRAM 8s67…cDWg · BLOCK #{block.toLocaleString()}
  </div>
);

const PanelHeader: FC<{ title: string; sub: string }> = ({ title, sub }) => (
  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
    <div>
      <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, fontWeight: 600, letterSpacing: "-0.02em", color: C.t1 }}>{title}</div>
      <div style={{ fontFamily: "Inter,sans-serif", fontSize: 10, fontWeight: 500, color: C.t3, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>{sub}</div>
    </div>
  </div>
);

const spread = (pts: number[]) => {
  const base = 10000;
  return pts.map((p) => base + (p - pts[0]));
};

export const SelfRepayingDemo: FC = () => {
  const [phase,        setPhase]        = useState(0);
  const [mark,         setMark]         = useState(182.34);
  const [leftBal,      setLeftBal]      = useState(10000.00);
  const [rightBal,     setRightBal]     = useState(10000.00);
  const [collLabel,    setCollLabel]    = useState<"USDC" | "morphing" | "JLP">("USDC");
  const [rightBorder,  setRightBorder]  = useState(C.border);
  const [, setFlashKey] = useState(0);
  const [flashVis,     setFlashVis]     = useState(false);
  const [showLeftRows, setShowLeftRows] = useState(false);
  const [showRightRows, setShowRightRows] = useState(false);
  const [showCrank,    setShowCrank]    = useState(false);
  const [showBadge,    setShowBadge]    = useState(false);
  const [showCaption,  setShowCaption]  = useState(false);
  const [crank,        setCrank]        = useState(9000);
  const [block,        setBlock]        = useState(312847221);
  const [panelOp,      setPanelOp]      = useState(1);
  const [leftPts,      setLeftPts]      = useState<number[]>(Array(24).fill(0));
  const [rightPts,     setRightPts]     = useState<number[]>(Array(24).fill(0));

  const tickRef = useRef(0);

  const reset = useCallback(() => {
    tickRef.current = 0;
    setPhase(0); setMark(182.34);
    setLeftBal(10000); setRightBal(10000);
    setCollLabel("USDC"); setRightBorder(C.border);
    setFlashKey(0); setFlashVis(false);
    setShowLeftRows(false); setShowRightRows(false);
    setShowCrank(false); setShowBadge(false);
    setShowCaption(false); setCrank(9000);
    setBlock(312847221); setPanelOp(1);
    setLeftPts(Array(24).fill(0));
    setRightPts(Array(24).fill(0));
  }, []);

  useEffect(() => {
    const TICK = 700;
    const id = window.setInterval(() => {
      tickRef.current++;
      const t = tickRef.current;

      setMark(() => parseFloat((182.34 + (Math.random() - 0.5) * 0.04).toFixed(2)));
      setBlock((b) => b + 1);
      setCrank((s) => Math.max(0, s - 1));

      if (t === 2) { setPhase(1); setShowLeftRows(true); }

      if (t >= 2 && t < 26 && (t - 2) % 3 === 0) {
        setLeftBal((v) => parseFloat((v - 0.03).toFixed(2)));
        setLeftPts((pts) => { const n = [...pts.slice(1)]; n.push(pts[pts.length - 1] - 2); return n; });
      }

      if (t === 6) {
        setPhase(2);
        setCollLabel("morphing");
        setRightBorder(C.accent);
        window.setTimeout(() => { setCollLabel("JLP"); setShowBadge(true); }, 300);
        window.setTimeout(() => setRightBorder(C.border), 800);
      }

      if (t === 9) { setPhase(3); setShowRightRows(true); window.setTimeout(() => setShowCrank(true), 600); }

      if (t >= 9 && t < 26 && (t - 9) % 3 === 0) {
        setRightBal((v) => parseFloat((v + 0.04).toFixed(2)));
        setRightPts((pts) => { const n = [...pts.slice(1)]; n.push(pts[pts.length - 1] + 3); return n; });
        setFlashKey((k) => k + 1);
        setFlashVis(true);
        window.setTimeout(() => setFlashVis(false), 600);
      }

      if (t === 22) {
        setPhase(4);
        setPanelOp(0.7);
        window.setTimeout(() => setShowCaption(true), 300);
      }

      if (t === 26) {
        setPanelOp(0.3);
        window.setTimeout(reset, 500);
      }
    }, TICK);
    return () => window.clearInterval(id);
  }, [reset]);

  const ch = Math.floor(crank / 3600).toString().padStart(2, "0");
  const cm = Math.floor((crank % 3600) / 60).toString().padStart(2, "0");
  const cs = (crank % 60).toString().padStart(2, "0");
  const crankStr = `${ch}:${cm}:${cs}`;

  const leftValStr  = leftBal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rightValStr = rightBal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const panelStyle: CSSProperties = {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 6, padding: 16,
    position: "relative", overflow: "hidden",
    display: "flex", flexDirection: "column",
    transition: "opacity 0.2s ease",
    opacity: panelOp,
  };

  return (
    <div className="self-repaying-demo" style={{ width: "100%", position: "relative", fontFamily: "Inter,sans-serif" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1px 1fr",
        gap: 0, width: "100%",
        aspectRatio: "5/2",
        minHeight: 320,
      }}>
        {/* LEFT */}
        <div style={panelStyle}>
          <Candlesticks />
          <OrderBook />
          <div style={{ position: "relative", zIndex: 2, flex: 1, display: "flex", flexDirection: "column" }}>
            <PanelHeader title="Standard Perpetual" sub="01 / Dead Collateral" />
            <DRow label="POSITION"   value="LONG · 5×"     col={C.t2} />
            <DRow label="MARKET"     value="SOL-PERP"      col={C.t2} />
            <DRow label="ENTRY"      value="181.92" />
            <DRow label="MARK"       value={mark.toFixed(2)} />
            <DRow label="SIZE"       value="50,000 USD" />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontFamily: "Inter,sans-serif", fontSize: 10, fontWeight: 500, color: C.t3, letterSpacing: "0.07em", textTransform: "uppercase" }}>COLLATERAL</span>
              <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontFeatureSettings: "'tnum' 1", color: C.t1 } as CSSProperties}>
                <AnimNum target={leftBal} decimals={2} color={C.t1} /> USDC
              </span>
            </div>
            <DRow label="UNREALIZED" value="+21.06" col={C.pos} />

            <div className={`fade-up${showLeftRows ? " visible" : ""}`} style={{ transitionDelay: "0ms" }}>
              <DRow label="FUNDING (8H)" value="−0.0214% · −2.14 USDC" col={C.neg} />
            </div>
            <div className={`fade-up${showLeftRows ? " visible" : ""}`} style={{ transitionDelay: "80ms" }}>
              <DRow label="YIELD APY" value="IDLE" col={C.t3} italic />
            </div>

            <div style={{ marginTop: "auto", paddingTop: 8 }}>
              <Sparkline
                points={spread(leftPts)}
                color={phase >= 1 ? C.neg : C.t3}
                label="BALANCE · LAST 8H"
                valueNode={
                  <span style={{ color: phase >= 1 ? C.neg : C.t2, fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontFeatureSettings: "'tnum' 1" } as CSSProperties}>{leftValStr}</span>
                }
              />
            </div>
            <StatusBar block={block} />
          </div>
        </div>

        {/* DIVIDER */}
        <div style={{ background: C.border, width: 1 }} />

        {/* RIGHT */}
        <div style={{ ...panelStyle, borderColor: rightBorder, transition: "opacity 0.3s ease, border-color 0.4s ease" }}>
          <Candlesticks />
          <OrderBook />
          <div style={{ position: "relative", zIndex: 2, flex: 1, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, fontWeight: 600, letterSpacing: "-0.02em", color: C.t1 }}>Self-Repaying Perpetual</div>
                <div style={{ fontFamily: "Inter,sans-serif", fontSize: 10, fontWeight: 500, color: C.t3, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>
                  01 / IDLEXCHANGE
                </div>
              </div>
              <div className={`fade-in${showCrank ? " visible" : ""}`} style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "3px 8px", borderRadius: 4,
                background: C.surface2, border: `1px solid ${C.border}`,
                fontFamily: "JetBrains Mono,monospace", fontSize: 9,
                color: C.t2, letterSpacing: "0.03em", whiteSpace: "nowrap",
              }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.accent, display: "inline-block", opacity: 0.8 }} />
                ◎ CRANK · NEXT {crankStr}
              </div>
            </div>

            <DRow label="POSITION"   value="LONG · 5×"     col={C.t2} />
            <DRow label="MARKET"     value="SOL-PERP"      col={C.t2} />
            <DRow label="ENTRY"      value="181.92" />
            <DRow label="MARK"       value={mark.toFixed(2)} />
            <DRow label="SIZE"       value="50,000 USD" />

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontFamily: "Inter,sans-serif", fontSize: 10, fontWeight: 500, color: C.t3, letterSpacing: "0.07em", textTransform: "uppercase" }}>COLLATERAL</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className={`flash-plus${!flashVis ? " hidden" : ""}`} style={{ color: C.pos, fontSize: 10, fontWeight: 600, fontFamily: "JetBrains Mono,monospace" }}>+</span>
                <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontFeatureSettings: "'tnum' 1", color: C.t1 } as CSSProperties}>
                  <AnimNum target={rightBal} decimals={2} color={C.t1} /> {collLabel === "morphing" ? "JLP" : collLabel}
                </span>
                <span className={`badge-scale${showBadge ? " visible" : ""}`} style={{
                  fontFamily: "JetBrains Mono,monospace", fontSize: 9, fontWeight: 500,
                  letterSpacing: "0.05em", textTransform: "uppercase",
                  color: C.pos, background: C.posBg,
                  border: `1px solid ${C.posBdr}`,
                  padding: "1px 5px", borderRadius: 4,
                }}>YIELD-BEARING</span>
              </div>
            </div>

            <DRow label="UNREALIZED" value="+21.06" col={C.pos} />

            <div className={`fade-up${showRightRows ? " visible" : ""}`} style={{ transitionDelay: "0ms" }}>
              <DRow label="YIELD APY" value="+24.8%" col={C.pos} />
            </div>
            <div className={`fade-up${showRightRows ? " visible" : ""}`} style={{ transitionDelay: "120ms" }}>
              <DRow label="FUNDING (8H)" value="−0.0214%" col={C.neg} />
            </div>
            <div className={`fade-up${showRightRows ? " visible" : ""}`} style={{ transitionDelay: "240ms" }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "5px 0",
                borderTop: `1px solid ${C.border}`,
                borderBottom: `1px solid ${C.border}`,
                marginTop: 2,
              }}>
                <span style={{ fontFamily: "Inter,sans-serif", fontSize: 10, fontWeight: 600, color: C.t2, letterSpacing: "0.07em", textTransform: "uppercase" }}>NET CARRY</span>
                <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 13, fontWeight: 500, color: C.pos }}>+0.0463% / 8h</span>
              </div>
            </div>

            <div style={{ marginTop: "auto", paddingTop: 8 }}>
              <Sparkline
                points={spread(rightPts)}
                color={phase >= 3 ? C.pos : C.t3}
                label="BALANCE · LAST 8H"
                valueNode={
                  <span style={{ color: phase >= 3 ? C.pos : C.t2, fontFamily: "JetBrains Mono,monospace", fontSize: 11, fontFeatureSettings: "'tnum' 1" } as CSSProperties}>{rightValStr}</span>
                }
              />
            </div>
            <StatusBar block={block} />
          </div>
        </div>
      </div>

      <div className={`caption-wrap${showCaption ? " visible" : ""}`} style={{ marginTop: 20, textAlign: "center", pointerEvents: "none" }}>
        <div style={{ fontFamily: "Inter,sans-serif", fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em", color: C.t1 }}>
          YOUR MARGIN SHOULD BE WORKING.
        </div>
        <div style={{ fontFamily: "Inter,sans-serif", fontSize: 13, fontWeight: 400, color: C.t3, marginTop: 4 }}>
          Self-repaying perpetuals. Verified by construction.
        </div>
      </div>
    </div>
  );
};
