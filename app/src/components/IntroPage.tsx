import { useEffect, useRef, useCallback, useState } from "react";

// ---- Canvas draw functions for warp objects ----

function drawSOLCoin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, _rot = 0) {
  if (r < 2) return;
  ctx.save(); ctx.globalAlpha = a;
  const g = ctx.createRadialGradient(x - r * .28, y - r * .28, r * .05, x, y, r);
  g.addColorStop(0, "#ede9fe"); g.addColorStop(0.4, "#a78bfa");
  g.addColorStop(0.82, "#5b21b6"); g.addColorStop(1, "#1a0840");
  ctx.shadowColor = "#a78bfa"; ctx.shadowBlur = r * 0.7;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = `900 ${r * 1.05}px Inter,sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("\u25CE", x, y);
  ctx.restore();
}

function drawCandle(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number, a: number, rot = 0) {
  if (sz < 4) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.translate(x, y); ctx.rotate(rot);
  const w = sz * 0.13;
  const cols = ["#3fb68b", "#ff5353", "#3fb68b", "#ff5353", "#3fb68b"];
  const hs = [0.42, 0.58, 0.32, 0.62, 0.46];
  cols.forEach((c, i) => {
    const bx = -sz * 0.38 + i * (sz * 0.19);
    ctx.shadowColor = c; ctx.shadowBlur = 5;
    ctx.fillStyle = c;
    ctx.fillRect(bx - w / 2, -hs[i] * sz / 2, w, hs[i] * sz);
    ctx.fillRect(bx - w * .12, -hs[i] * sz * .68, w * .24, hs[i] * sz * .38);
  });
  ctx.restore();
}

function drawLightning(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number, a: number, rot = 0) {
  if (sz < 4) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.shadowColor = "#00FF57"; ctx.shadowBlur = sz * 0.5;
  ctx.fillStyle = "#00FF57";
  ctx.beginPath();
  ctx.moveTo(sz * .18, -sz * .5);
  ctx.lineTo(-sz * .08, -sz * .02);
  ctx.lineTo(sz * .09, -sz * .02);
  ctx.lineTo(-sz * .18, sz * .5);
  ctx.lineTo(sz * .09, sz * .06);
  ctx.lineTo(-sz * .04, sz * .06);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawTriangle(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number, a: number, rot = 0) {
  if (sz < 4) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.shadowColor = "#a78bfa"; ctx.shadowBlur = sz * 0.4;
  ctx.fillStyle = "#a78bfa";
  ctx.beginPath();
  ctx.moveTo(0, sz * .54); ctx.lineTo(-sz * .52, -sz * .44); ctx.lineTo(sz * .52, -sz * .44);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#c4b5fd";
  ctx.fillRect(-sz * .52, -sz * .5, sz * 1.04, sz * .12);
  ctx.restore();
}

function drawPriceBox(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number, a: number, rot = 0) {
  if (sz < 10) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.translate(x, y); ctx.rotate(rot);
  const bw = sz * 1.3, bh = sz * .6;
  ctx.shadowColor = "#a78bfa"; ctx.shadowBlur = 14;
  ctx.fillStyle = "#0d1117"; ctx.strokeStyle = "#a78bfa"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.rect(-bw / 2, -bh / 2, bw, bh); ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.font = `600 ${sz * .27}px 'IBM Plex Mono',monospace`;
  ctx.fillStyle = "#3fb68b"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("$142.30", 0, -sz * .07);
  ctx.font = `500 ${sz * .17}px 'IBM Plex Mono',monospace`;
  ctx.fillStyle = "#8b949e"; ctx.fillText("SOL-USD  +2.4%", 0, sz * .16);
  ctx.restore();
}

function drawChain(ctx: CanvasRenderingContext2D, x: number, y: number, sz: number, a: number, rot = 0) {
  if (sz < 4) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.strokeStyle = "#58a6ff"; ctx.lineWidth = sz * .1;
  ctx.shadowColor = "#58a6ff"; ctx.shadowBlur = 16;
  const rx = sz * .3, ry = sz * .15;
  ctx.beginPath(); ctx.ellipse(-sz * .2, 0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(sz * .2, 0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

type DrawFn = (ctx: CanvasRenderingContext2D, x: number, y: number, sz: number, a: number, rot: number) => void;
const DRAW_FNS: DrawFn[] = [drawSOLCoin, drawCandle, drawLightning, drawTriangle, drawPriceBox, drawChain];
const TYPE_COIN = 0;
const FOCAL = 520;

// ---- 3D warp particle ----

class Warp {
  type: number;
  x = 0; y = 0; z = 0;
  rot = 0; rotV = 0; sz = 0;

  constructor(init: boolean) {
    this.type = Math.floor(Math.random() * DRAW_FNS.length);
    this.reset(init ? Math.random() * 2800 + 400 : 2800 + Math.random() * 400);
  }

  reset(z: number) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 40 + Math.random() * 340;
    this.x = Math.cos(ang) * rad;
    this.y = Math.sin(ang) * rad;
    this.z = z;
    this.rot = Math.random() * Math.PI * 2;
    this.rotV = (Math.random() - 0.5) * 0.07;
    this.sz = 38 + Math.random() * 44;
    this.type = Math.floor(Math.random() * DRAW_FNS.length);
  }

  update(sp: number) {
    this.z -= sp; this.rot += this.rotV;
    if (this.z < 5) this.reset(2900 + Math.random() * 400);
  }

  draw(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.z <= 0) return;
    const sc = FOCAL / this.z;
    const sx = W / 2 + this.x * sc, sy = H / 2 + this.y * sc;
    const ss = this.sz * sc;
    const fade = Math.min(1, this.z / 500) * Math.min(1, (3200 - this.z) / 600);
    if (fade <= 0 || ss < 1) return;
    const fn = DRAW_FNS[this.type];
    fn(ctx, sx, sy, this.type === TYPE_COIN ? ss / 2 : ss, fade, this.rot);
  }
}

// ---- Helper draw functions ----

function drawBg(ctx: CanvasRenderingContext2D, W: number, H: number, tsec: number) {
  ctx.fillStyle = "#030309"; ctx.fillRect(0, 0, W, H);
  ctx.save();
  const lineAlpha = 0.03 + Math.sin(tsec * 1.5) * 0.015;
  ctx.strokeStyle = `rgba(167,139,250,${lineAlpha})`;
  ctx.lineWidth = 1;
  const shift = (tsec * 55) % (W * .13);
  for (let i = -4; i < 12; i++) {
    const lx = i / 9 * W + shift;
    ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx + H, H); ctx.stroke();
  }
  [120, 200, 310].forEach((r, i) => {
    const pulse = r + Math.sin(tsec * 2.5 + i) * 14;
    ctx.strokeStyle = "rgba(167,139,250,0.04)";
    ctx.beginPath(); ctx.arc(W / 2, H / 2, pulse, 0, Math.PI * 2); ctx.stroke();
  });
  ctx.restore();
}

const GEO_PANELS = [
  { dir: 1, color: "#071a0a", t0: 0.00, t1: 0.45 },
  { dir: -1, color: "#000", t0: 0.08, t1: 0.50 },
  { dir: 1, color: "#a78bfa", t0: 0.18, t1: 0.55 },
  { dir: -1, color: "#00FF57", t0: 0.28, t1: 1.00 },
];
function easeInOut(t: number) { return t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

function drawGeo(ctx: CanvasRenderingContext2D, W: number, H: number, p: number) {
  GEO_PANELS.forEach(gp => {
    const lp = Math.max(0, Math.min(1, (p - gp.t0) / (gp.t1 - gp.t0)));
    const e = easeInOut(lp);
    ctx.fillStyle = gp.color;
    if (gp.dir === 1) ctx.fillRect(0, 0, e * W, H);
    else ctx.fillRect(W - e * W, 0, e * W, H);
  });
}

function easeOut3(t: number) { return 1 - Math.pow(1 - t, 3); }

function drawLogoCanvas(ctx: CanvasRenderingContext2D, cx: number, cy: number, alpha: number, W: number, H: number) {
  const sz = Math.min(W, H) * 0.21;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  const tw = sz * 1.3, th = sz * 0.135;
  ctx.fillStyle = "#071a0a";
  ctx.fillRect(-tw / 2, -sz * .62, tw, th);
  ctx.font = `900 ${sz * .065}px Inter,sans-serif`;
  ctx.fillStyle = "#00FF57"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("ATOMIC PERPS", 0, -sz * .555);
  ctx.beginPath();
  ctx.moveTo(0, sz * .68); ctx.lineTo(-sz * .65, -sz * .49); ctx.lineTo(sz * .65, -sz * .49);
  ctx.closePath(); ctx.fillStyle = "#071a0a"; ctx.fill();
  ctx.strokeStyle = "rgba(162,248,169,0.22)"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, -sz * .49); ctx.lineTo(0, sz * .68); ctx.stroke();
  ctx.font = `900 ${sz * .57}px Inter,sans-serif`;
  ctx.fillStyle = "#00FF57"; ctx.textBaseline = "middle";
  ctx.fillText("IDL", 0, sz * .075);
  ctx.restore();
}

function drawIris(ctx: CanvasRenderingContext2D, W: number, H: number, p: number) {
  const maxR = Math.sqrt(W * W + H * H) * 0.72;
  const r = easeOut3(p) * maxR;
  ctx.fillStyle = "#00FF57"; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2, true);
  ctx.fillStyle = "#000"; ctx.fill();
  ctx.restore();
  if (p > 0.35) {
    const la = Math.min(1, (p - 0.35) / 0.4);
    drawLogoCanvas(ctx, W / 2, H / 2 - 55, la, W, H);
  }
}

function overlayFlash(ctx: CanvasRenderingContext2D, W: number, H: number, color: string, alpha: number) {
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
}

// ---- Animated Character SVG ----

function CharacterSVG() {
  return (
    <div id="char-container" style={{ animation: "kickLean 6s ease-in-out 1.5s infinite" }}>
      <svg width="180" height="330" viewBox="0 0 110 210" style={{ flexShrink: 0, overflow: "visible" }}>
        {/* Ground shadow */}
        <ellipse id="char-shadow" cx="55" cy="200" rx="34" ry="7" fill="#071a0a"
          style={{ animation: "shadow 2.4s ease-in-out infinite", transformOrigin: "center" }} />

        <g id="char-body" style={{ animation: "idle 2.4s ease-in-out infinite" }}>
          {/* Shoes */}
          <rect x="28" y="174" width="24" height="13" rx="7" fill="#071a0a" />
          <g className="kick-r" style={{ transformOrigin: "70px 134px", animation: "kickLeg 6s ease-in-out 1.5s infinite" }}>
            <rect x="62" y="134" width="15" height="44" rx="7" fill="#0d2212" />
            <rect x="58" y="174" width="24" height="13" rx="7" fill="#071a0a" />
          </g>

          {/* Legs */}
          <rect x="33" y="134" width="15" height="44" rx="7" fill="#0d2212" />

          {/* Suit body */}
          <rect x="24" y="80" width="62" height="60" rx="10" fill="#071a0a" />
          {/* Shirt */}
          <rect x="43" y="80" width="24" height="32" rx="5" fill="#183320" />
          {/* Tie */}
          <polygon points="55,86 59,104 55,110 51,104" fill="#a78bfa" />
          {/* Lapels */}
          <polygon points="43,80 36,108 44,108" fill="#0d2212" />
          <polygon points="67,80 74,108 66,108" fill="#0d2212" />
          {/* Suit button */}
          <circle cx="55" cy="120" r="2.5" fill="#a78bfa" opacity="0.7" />

          {/* Left arm (raised) */}
          <g className="arm-l-g" style={{
            transformOrigin: "20px 84px",
            animation: "raiseArm 0.75s cubic-bezier(0.34,1.56,0.64,1) 0.5s both, gentleWave 2.2s ease-in-out 1.3s infinite",
          }}>
            <rect x="10" y="82" width="15" height="44" rx="7" fill="#071a0a" />
            <circle cx="17" cy="128" r="7" fill="#1a4a22" />
          </g>

          {/* Right arm + phone */}
          <g className="arm-r-g" style={{
            animation: "armR 2.4s ease-in-out infinite",
            transformOrigin: "90px 84px",
          }}>
            <rect x="85" y="82" width="15" height="44" rx="7" fill="#071a0a" />
            <circle cx="93" cy="128" r="7" fill="#1a4a22" />
            {/* Phone body */}
            <rect x="87" y="116" width="13" height="20" rx="3" fill="#161b22" />
            {/* Phone screen */}
            <rect x="89" y="118" width="9" height="14" rx="1" fill="#0d1117" />
            {/* Mini chart */}
            <polyline points="90,129 91.5,125 93,127.5 95.5,122" fill="none" stroke="#3fb68b"
              strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          {/* Neck */}
          <rect x="47" y="70" width="16" height="14" rx="7" fill="#1a4a22" />

          {/* Head */}
          <circle cx="55" cy="46" r="28" fill="#1a4a22" />

          {/* Hair top */}
          <path d="M29,40 Q30,8 55,7 Q80,8 81,40 Q73,20 55,18 Q37,20 29,40Z" fill="#071a0a" />
          {/* Hair sides */}
          <rect x="27" y="33" width="8" height="16" rx="4" fill="#071a0a" />
          <rect x="75" y="33" width="8" height="16" rx="4" fill="#071a0a" />

          {/* Eyebrows */}
          <rect x="37" y="33" width="14" height="3.5" rx="1.5" fill="#071a0a" />
          <rect x="59" y="33" width="14" height="3.5" rx="1.5" fill="#071a0a" />

          {/* Left eye */}
          <g className="eye-l" style={{
            transformBox: "fill-box" as any, transformOrigin: "center",
            animation: "blink 4.2s ease-in-out infinite",
          }}>
            <ellipse cx="45" cy="44" rx="6" ry="6" fill="white" />
            <circle cx="46" cy="45" r="3" fill="#071a0a" />
            <circle cx="47" cy="43" r="1.2" fill="white" />
          </g>
          {/* Right eye */}
          <g className="eye-r" style={{
            transformBox: "fill-box" as any, transformOrigin: "center",
            animation: "blink 4.2s ease-in-out 0.06s infinite",
          }}>
            <ellipse cx="65" cy="44" rx="6" ry="6" fill="white" />
            <circle cx="66" cy="45" r="3" fill="#071a0a" />
            <circle cx="67" cy="43" r="1.2" fill="white" />
          </g>

          {/* Smile */}
          <path d="M46,57 Q55,65 64,57" fill="none" stroke="#071a0a" strokeWidth="2.5" strokeLinecap="round" />

          {/* SOL badge on lapel */}
          <circle cx="37" cy="94" r="5.5" fill="#a78bfa" opacity="0.85" />
          <text x="37" y="97" textAnchor="middle" fontSize="6" fontFamily="Inter,sans-serif" fill="white">{"\u25CE"}</text>
        </g>
      </svg>
    </div>
  );
}

// ---- Main component ----

const T1 = 2600, T2 = 3300, T3 = 4400;

export function IntroPage({ onEnter }: { onEnter: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const warpsRef = useRef<Warp[]>([]);
  const t0Ref = useRef<number | null>(null);
  const [finalVisible, setFinalVisible] = useState(false);
  const [taglineShow, setTaglineShow] = useState(false);
  const [btnShow, setBtnShow] = useState(false);
  const [skipDark, setSkipDark] = useState(false);
  const finalShownRef = useRef(false);
  const dimRef = useRef({ w: 0, h: 0 });

  // Initialize warps
  useEffect(() => {
    warpsRef.current = Array.from({ length: 24 }, () => new Warp(true));
  }, []);

  const showFinal = useCallback(() => {
    if (finalShownRef.current) return;
    finalShownRef.current = true;
    const c = canvasRef.current;
    if (c) c.style.display = "none";
    setFinalVisible(true);
    setSkipDark(true);
    setTimeout(() => setTaglineShow(true), 200);
    setTimeout(() => setBtnShow(true), 500);
  }, []);

  const skipToEnd = useCallback(() => {
    t0Ref.current = performance.now() - T3 - 10;
  }, []);

  // Canvas animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let W: number, H: number;

    const resize = () => {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
      dimRef.current = { w: W, h: H };
    };
    resize();
    window.addEventListener("resize", resize);

    let speed = 16;
    let raf: number;

    const frame = (ts: number) => {
      if (t0Ref.current === null) t0Ref.current = ts;
      const ms = ts - t0Ref.current;

      if (ms < T1) {
        // PHASE 1 - WARP
        const prog = ms / T1;
        ctx.fillStyle = "rgba(0,0,0,0.15)"; ctx.fillRect(0, 0, W, H);
        drawBg(ctx, W, H, ms / 1000);
        speed = 14 + prog * 80;
        warpsRef.current.forEach(w => { w.update(speed); w.draw(ctx, W, H); });
        if (ms < 100) overlayFlash(ctx, W, H, "#a78bfa", (1 - ms / 100) * 0.7);
        if (ms > 880 && ms < 1040) {
          const f = Math.sin((ms - 880) / 160 * Math.PI);
          overlayFlash(ctx, W, H, "#ffffff", f * 0.22);
        }
        if (ms > T1 - 120) overlayFlash(ctx, W, H, "#fff", (ms - (T1 - 120)) / 120 * 0.5);
      } else if (ms < T2) {
        // PHASE 2 - GEO SWEEP
        ctx.clearRect(0, 0, W, H);
        drawGeo(ctx, W, H, (ms - T1) / (T2 - T1));
      } else if (ms < T3) {
        // PHASE 3 - IRIS REVEAL
        ctx.clearRect(0, 0, W, H);
        drawIris(ctx, W, H, (ms - T2) / (T3 - T2));
      } else {
        // PHASE 4 - FINAL
        showFinal();
        return;
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [showFinal]);

  // Click-to-skip (after 900ms)
  useEffect(() => {
    let clickOk = false;
    const timer = setTimeout(() => { clickOk = true; }, 900);
    const handler = (e: MouseEvent) => {
      if (!clickOk) return;
      if ((e.target as HTMLElement).closest("#enter-btn") || (e.target as HTMLElement).closest("#skip")) return;
      skipToEnd();
    };
    document.body.addEventListener("click", handler);
    return () => {
      clearTimeout(timer);
      document.body.removeEventListener("click", handler);
    };
  }, [skipToEnd]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      {/* Keyframe animations injected as style tag */}
      <style>{`
        @keyframes idle {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-6px); }
        }
        @keyframes blink {
          0%, 84%, 94%, 100% { transform: scaleY(1); }
          89% { transform: scaleY(0.08); }
        }
        @keyframes raiseArm {
          from { transform: rotate(0deg); }
          to { transform: rotate(-118deg); }
        }
        @keyframes gentleWave {
          0%, 100% { transform: rotate(-118deg); }
          50% { transform: rotate(-130deg); }
        }
        @keyframes armR {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(-5deg); }
        }
        @keyframes shadow {
          0%, 100% { transform: scaleX(1); opacity: 0.18; }
          50% { transform: scaleX(0.82); opacity: 0.1; }
        }
        @keyframes fadeUp {
          from { transform: translateY(14px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes kickLean {
          0%, 2.5%, 100% { transform: rotate(0deg) translateX(0); }
          1% { transform: rotate(-5deg) translateX(-4px); }
          2% { transform: rotate(7deg) translateX(5px); }
          4% { transform: rotate(0deg) translateX(0); }
        }
        @keyframes kickLeg {
          0%, 1.5%, 14%, 100% { transform: rotate(0deg); }
          0.8% { transform: rotate(-32deg); }
          2.2% { transform: rotate(58deg); }
          5% { transform: rotate(22deg); }
          9% { transform: rotate(0deg); }
        }
        @keyframes wordHit {
          0%, 2.2%, 100% { transform: translateX(0) rotate(0deg); }
          4% { transform: translateX(24px) rotate(2.5deg); }
          9% { transform: translateX(58px) rotate(6deg); }
          16% { transform: translateX(36px) rotate(3deg); }
          22% { transform: translateX(10px) rotate(1deg); }
          27% { transform: translateX(0) rotate(0deg); }
        }
      `}</style>

      {/* Final screen (mint green) */}
      <div style={{
        position: "fixed", inset: 0, zIndex: 5,
        background: "#00FF57",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        opacity: finalVisible ? 1 : 0,
        transition: "opacity 0.3s",
        pointerEvents: finalVisible ? "auto" : "none",
      }}>
        {/* Geometric SVG lines */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
          viewBox="0 0 1440 900" preserveAspectRatio="none">
          <line x1="220" y1="0" x2="0" y2="220" stroke="#071a0a" strokeWidth="1.2" />
          <line x1="1220" y1="0" x2="1440" y2="220" stroke="#071a0a" strokeWidth="1.2" />
          <line x1="0" y1="680" x2="220" y2="900" stroke="#071a0a" strokeWidth="1.2" />
          <line x1="1440" y1="680" x2="1220" y2="900" stroke="#071a0a" strokeWidth="1.2" />
          <path d="M30 38 L30 18 L50 18" fill="none" stroke="#071a0a" strokeWidth="2.5" />
          <path d="M1410 38 L1410 18 L1390 18" fill="none" stroke="#071a0a" strokeWidth="2.5" />
          <path d="M30 862 L30 882 L50 882" fill="none" stroke="#071a0a" strokeWidth="2.5" />
          <path d="M1410 862 L1410 882 L1390 882" fill="none" stroke="#071a0a" strokeWidth="2.5" />
        </svg>

        <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          {/* Hero row: character + branding */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 40, justifyContent: "center", marginBottom: 8 }}>
            <CharacterSVG />

            {/* Branding column */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", paddingBottom: 22 }}>
              <div style={{
                fontSize: 72, fontWeight: 900,
                letterSpacing: "-0.04em", color: "#ffffff",
                lineHeight: 1, textAlign: "left",
                animation: "wordHit 6s ease-in-out 1.5s infinite",
              }}>
                IDL<span style={{ color: "#071a0a" }}>Exchange</span>
              </div>
              <div style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 11, letterSpacing: "0.16em",
                color: "rgba(7,26,10,0.45)", marginTop: 8,
                textTransform: "uppercase",
              }}>
                Solana &middot; Atomic &middot; DeFi
              </div>
            </div>
          </div>

          {/* Tagline */}
          <div style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11, letterSpacing: "0.18em",
            color: "rgba(7,26,10,0.5)", textTransform: "uppercase",
            whiteSpace: "nowrap",
            opacity: 0,
            ...(taglineShow ? { animation: "fadeUp 0.7s ease forwards" } : {}),
          }}>
            One Transaction &middot; Three Protocols &middot; All or Nothing
          </div>

          {/* Enter button */}
          <div style={{
            marginTop: 38, opacity: 0,
            ...(btnShow ? { animation: "fadeUp 0.7s ease 0.35s forwards" } : {}),
          }}>
            <button id="enter-btn" onClick={onEnter} style={{
              display: "inline-block", padding: "14px 42px",
              background: "#071a0a", color: "#00FF57",
              fontSize: 13, fontWeight: 900,
              letterSpacing: "0.12em", textTransform: "uppercase",
              textDecoration: "none", borderRadius: 3,
              border: "none", cursor: "pointer",
              fontFamily: "'Inter', sans-serif",
              transition: "transform 0.2s, box-shadow 0.2s",
            }}
            onMouseEnter={e => {
              (e.currentTarget).style.transform = "translateY(-2px)";
              (e.currentTarget).style.boxShadow = "0 10px 36px rgba(7,26,10,0.25)";
            }}
            onMouseLeave={e => {
              (e.currentTarget).style.transform = "translateY(0)";
              (e.currentTarget).style.boxShadow = "none";
            }}
            >Enter Terminal &rarr;</button>
          </div>
        </div>
      </div>

      {/* Animation canvas (on top) */}
      <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, zIndex: 10, display: "block" }} />

      {/* Skip button */}
      <div id="skip" onClick={skipToEnd} style={{
        position: "fixed", top: 18, right: 20, zIndex: 100,
        fontSize: 11, cursor: "pointer", letterSpacing: "0.1em", textTransform: "uppercase",
        transition: "color 0.2s",
        color: skipDark ? "rgba(7,26,10,0.3)" : "rgba(255,255,255,0.22)",
      }}>&nbsp;</div>
    </div>
  );
}
