import { useEffect, useRef, FC } from "react";

const T = {
  bg:          "#000000",
  surface:     "#0A0A0B",
  surface2:    "#111114",
  border:      "#1A1A1F",
  borderLit:   "#26262E",
  text1:       "#E5E5E7",
  text2:       "#8B8B94",
  text3:       "#4A4A52",
  positive:    "#22C55E",
  positiveBg:  "rgba(34,197,94,0.08)",
  negative:    "#EF4444",
  negativeBg:  "rgba(239,68,68,0.08)",
  warning:     "#F59E0B",
  accent:      "#A78BFA",
  accentFill:  "rgba(167,139,250,0.12)",
};

const ENTRY = 180;
const SIZE  = 10000;
const PRICE_MIN = 120, PRICE_MAX = 360;
const PNL_MIN = -10000, PNL_MAX = 30000;
const LOOP_DURATION = 8500;

const linearPnl = (p: number) => ((p - ENTRY) / ENTRY) * SIZE;
const powerPnl  = (p: number) => ((p * p - ENTRY * ENTRY) / (ENTRY * ENTRY)) * SIZE;

function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number) {
  return (t: number) => {
    const cx = (u: number) => 3 * p1x * u * (1 - u) * (1 - u) + 3 * p2x * u * u * (1 - u) + u * u * u;
    const cy = (u: number) => 3 * p1y * u * (1 - u) * (1 - u) + 3 * p2y * u * u * (1 - u) + u * u * u;
    let lo = 0, hi = 1, mid = 0;
    for (let i = 0; i < 20; i++) { mid = (lo + hi) / 2; if (cx(mid) < t) lo = mid; else hi = mid; }
    return cy(mid);
  };
}
const easeOut = cubicBezier(0.16, 1, 0.3, 1);
const easeIn  = cubicBezier(0.7, 0, 0.84, 0);

const lerp    = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp   = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const invlerp = (a: number, b: number, v: number) => clamp((v - a) / (b - a), 0, 1);
const mapRange = (v: number, a: number, b: number, c: number, d: number) => lerp(c, d, invlerp(a, b, v));

interface Rect { x: number; y: number; w: number; h: number; }
interface Mapper { px: (price: number) => number; py: (pnl: number) => number; }

export const PowerPerpScene: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef   = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    let W = 0, H = 0, dpr = 1;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      W = r.width; H = r.height;
      if (W <= 0 || H <= 0) return;
      dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener("resize", resize);
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const setMono  = (size: number, weight = "400") => { ctx.font = `${weight} ${size}px "JetBrains Mono", monospace`; };
    const setInter = (size: number, weight = "400") => { ctx.font = `${weight} ${size}px Inter, sans-serif`; };

    const fmtPrice = (v: number) => v.toFixed(2);
    const fmtPnl   = (v: number) => {
      const abs = Math.abs(v);
      const sign = v >= 0 ? "+" : "−";
      if (abs >= 1000) return sign + Math.round(abs).toLocaleString("en-US");
      return sign + abs.toFixed(2);
    };
    const fmtLeverage = (v: number) => v.toFixed(2) + "×";

    const getLayout = () => {
      const divX = W / 2;
      const tsBarH = Math.round(H * 0.06);
      const topStripH = Math.round(H * 0.185);
      const statusH = Math.round(H * 0.05);
      const chartH = H - tsBarH - topStripH - statusH - 3;
      const chartPad = { t: 14, r: 14, b: 28, l: 52 };

      const lp = {
        x: 0, y: tsBarH, w: divX, h: H - tsBarH,
        chartArea: {
          x: chartPad.l,
          y: tsBarH + topStripH + 1 + chartPad.t,
          w: divX - chartPad.l - chartPad.r,
          h: chartH - chartPad.t - chartPad.b,
        },
      };
      const rp = {
        x: divX + 1, y: tsBarH, w: W - divX - 1, h: H - tsBarH,
        chartArea: {
          x: divX + 1 + chartPad.l,
          y: tsBarH + topStripH + 1 + chartPad.t,
          w: W - divX - 1 - chartPad.l - chartPad.r,
          h: chartH - chartPad.t - chartPad.b,
        },
      };
      return { divX, tsBarH, topStripH, statusH, chartH, lp, rp };
    };

    const makeMapper = (rect: Rect): Mapper => ({
      px: (price) => mapRange(price, PRICE_MIN, PRICE_MAX, rect.x, rect.x + rect.w),
      py: (pnl)   => mapRange(pnl,   PNL_MAX,   PNL_MIN,   rect.y, rect.y + rect.h),
    });

    const buildLinearPath = (m: Mapper, steps = 200) => {
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= steps; i++) {
        const p = lerp(PRICE_MIN, PRICE_MAX, i / steps);
        pts.push({ x: m.px(p), y: m.py(linearPnl(p)) });
      }
      return pts;
    };
    const buildPowerPath = (m: Mapper, steps = 200) => {
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= steps; i++) {
        const p = lerp(PRICE_MIN, PRICE_MAX, i / steps);
        pts.push({ x: m.px(p), y: m.py(powerPnl(p)) });
      }
      return pts;
    };

    const drawPathFull = (pts: { x: number; y: number }[], color: string, lineWidth: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = "round";
      ctx.lineCap  = "round";
      ctx.beginPath();
      pts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.stroke();
      ctx.restore();
    };

    const drawPathPartial = (pts: { x: number; y: number }[], color: string, lineWidth: number, alpha: number, progress: number) => {
      if (progress <= 0) return;
      const n = Math.floor(pts.length * progress);
      const remainder = (pts.length * progress) - n;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = "round";
      ctx.lineCap  = "round";
      ctx.beginPath();
      for (let i = 0; i <= Math.min(n, pts.length - 1); i++) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
        else ctx.lineTo(pts[i].x, pts[i].y);
      }
      if (n < pts.length - 1 && remainder > 0) {
        const ax = pts[n].x, ay = pts[n].y;
        const bx = pts[n+1].x, by = pts[n+1].y;
        ctx.lineTo(lerp(ax, bx, remainder), lerp(ay, by, remainder));
      }
      ctx.stroke();
      ctx.restore();
    };

    const drawPowerFill = (pts: { x: number; y: number }[], m: Mapper, alpha: number, progress: number) => {
      if (progress <= 0 || alpha <= 0) return;
      const n = Math.min(Math.floor(pts.length * progress), pts.length - 1);
      const rem = (pts.length * progress) - Math.floor(pts.length * progress);
      const y0 = m.py(0);

      let endX, endY;
      if (n < pts.length - 1 && rem > 0) {
        endX = lerp(pts[n].x, pts[n+1].x, rem);
        endY = lerp(pts[n].y, pts[n+1].y, rem);
      } else {
        endX = pts[n].x; endY = pts[n].y;
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = T.accent;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, y0);
      ctx.lineTo(pts[0].x, pts[0].y);
      for (let i = 1; i <= n; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (n < pts.length - 1 && rem > 0) ctx.lineTo(endX, endY);
      ctx.lineTo(endX, y0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const drawGrid = (ca: Rect, m: Mapper) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ca.x, ca.y, ca.w, ca.h);
      ctx.clip();
      ctx.strokeStyle = T.border;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      [-10000, 0, 10000, 20000, 30000].forEach(pnl => {
        const y = m.py(pnl);
        ctx.beginPath(); ctx.moveTo(ca.x, y); ctx.lineTo(ca.x + ca.w, y); ctx.stroke();
      });
      [120, 180, 240, 300, 360].forEach(price => {
        const x = m.px(price);
        ctx.beginPath(); ctx.moveTo(x, ca.y); ctx.lineTo(x, ca.y + ca.h); ctx.stroke();
      });
      ctx.restore();
    };

    const drawGridLabels = (ca: Rect, m: Mapper) => {
      ctx.save();
      ctx.globalAlpha = 0.8;
      setMono(10, "400");
      ctx.fillStyle = T.text3;
      ctx.textAlign = "right";
      [-10000, 0, 10000, 20000, 30000].forEach(pnl => {
        const y = m.py(pnl);
        if (y < ca.y - 6 || y > ca.y + ca.h + 6) return;
        let lbl = pnl === 0 ? "0" : (pnl > 0 ? "+" + (pnl / 1000) + "K" : (pnl / 1000) + "K");
        ctx.fillText(lbl, ca.x - 6, y + 3.5);
      });
      ctx.textAlign = "center";
      [120, 180, 240, 300, 360].forEach(price => {
        const x = m.px(price);
        ctx.fillText(String(price), x, ca.y + ca.h + 14);
      });
      ctx.restore();
    };

    const drawCrosshair = (m: Mapper, ca: Rect) => {
      const ox = m.px(ENTRY);
      const oy = m.py(0);
      ctx.save();
      ctx.strokeStyle = T.text3;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(ca.x, oy); ctx.lineTo(ca.x + ca.w, oy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ox, ca.y); ctx.lineTo(ox, ca.y + ca.h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    };

    const drawPositionCard = (x: number, y: number, w: number, h: number, isRight: boolean, markPrice: number, pnlVal: number, pnlAlpha: number) => {
      const pad = 14;
      ctx.save();
      setMono(9, "400");
      ctx.fillStyle = T.text3;
      ctx.textAlign = "right";
      ctx.fillText(isRight ? "03 / IDLEXCHANGE" : "03 / LINEAR PAYOFF", x + w - pad, y + 13);

      setInter(11.5, "600");
      ctx.fillStyle = T.text1;
      ctx.textAlign = "left";
      ctx.fillText(isRight ? "POWER PERPETUAL · SOL²" : "STANDARD PERPETUAL", x + pad, y + 13);

      ctx.strokeStyle = T.border;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(x, y + 20); ctx.lineTo(x + w, y + 20); ctx.stroke();

      const colAx    = x + pad;
      const colAvalx = x + w * 0.36;
      const colBx    = x + w * 0.5 + pad;
      const colBvalx = x + w - pad;
      const rowStart = y + 32;
      const rowStep  = (h - 32 - 8) / 3;

      const leftRows = [
        { label: "POSITION", val: "LONG · 1×", color: T.text2 },
        { label: "ENTRY",    val: "180.00",    color: T.text2 },
        { label: "PNL",      val: null,         color: null   },
      ];
      const rightRows = [
        { label: "MARKET", val: isRight ? "SOL²-PERP" : "SOL-PERP", color: T.text2 },
        { label: "MARK",   val: fmtPrice(markPrice),                 color: T.text1 },
        { label: "SIZE",   val: "10,000 USD",                        color: T.text2 },
      ];

      leftRows.forEach((row, i) => {
        const ry = rowStart + rowStep * i + rowStep * 0.62;
        setMono(9, "400");
        ctx.fillStyle = T.text3;
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
        ctx.fillText(row.label, colAx, ry);

        if (row.label === "PNL") {
          let pnlColor: string;
          if (isRight) {
            if (pnlVal >= 5000)  pnlColor = T.positive;
            else if (pnlVal < 0) pnlColor = T.negative;
            else                 pnlColor = T.text2;
          } else {
            if (pnlVal >= 10000)     pnlColor = T.positive;
            else if (pnlVal >= 5000) pnlColor = T.text2;
            else if (pnlVal < 0)     pnlColor = T.negative;
            else                     pnlColor = T.text3;
          }
          const pnlWeight = (isRight && pnlVal >= 15000) ? "600" : "500";
          setMono(10, pnlWeight);
          ctx.fillStyle = pnlColor;
          ctx.textAlign = "right";
          ctx.globalAlpha = pnlAlpha;
          ctx.fillText(fmtPnl(pnlVal), colAvalx, ry);
          ctx.globalAlpha = 1;
        } else {
          setMono(10, "500");
          ctx.fillStyle = row.color!;
          ctx.textAlign = "right";
          ctx.fillText(row.val!, colAvalx, ry);
        }
      });

      rightRows.forEach((row, i) => {
        const ry = rowStart + rowStep * i + rowStep * 0.62;
        setMono(9, "400");
        ctx.fillStyle = T.text3;
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
        ctx.fillText(row.label, colBx, ry);
        setMono(10, "500");
        ctx.fillStyle = row.color;
        ctx.textAlign = "right";
        ctx.fillText(row.val, colBvalx, ry);
      });
      ctx.restore();
    };

    let blockNum = 312847221;
    let lastBlockTick = 0;
    const drawStatusBar = (y: number, h: number, t: number) => {
      if (t - lastBlockTick > 400) { blockNum++; lastBlockTick = t; }
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = T.text2;
      setMono(9, "400");
      ctx.textAlign = "left";
      ctx.fillText(`MAINNET · PROGRAM 8s67…cDWg · BLOCK #${blockNum.toLocaleString("en-US")}`, 16, y + h * 0.65);
      ctx.restore();
    };

    const drawDot = (x: number, y: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = T.text1;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };

    const drawChartTag = (ca: Rect, isRight: boolean) => {
      ctx.save();
      ctx.globalAlpha = 1;
      setMono(10, "400");
      ctx.fillStyle = T.text3;
      ctx.textAlign = "left";
      ctx.fillText(isRight ? "SOL² INDEX" : "SOL INDEX", ca.x + 4, ca.y + 13);
      ctx.restore();
    };

    const drawLinearCeiling = (m: Mapper, ca: Rect, alpha: number) => {
      if (alpha <= 0) return;
      const y = m.py(20000);
      ctx.save();
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = T.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(ca.x, y); ctx.lineTo(ca.x + ca.w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha;
      setMono(10, "400");
      ctx.fillStyle = T.text3;
      ctx.textAlign = "left";
      ctx.fillText("LINEAR CEILING", ca.x + 4, y - 5);
      ctx.restore();
    };

    const drawLedger = (ly: number, alpha: number, isRight: boolean, pnlVal: number, leverage: number) => {
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const pad = 16;
      const startX = isRight ? W / 2 + pad : pad;
      const colW   = W / 2 - pad * 2;
      const rows = [
        { label: "PRICE MOVE",         val: "+100%",            color: T.text2 },
        { label: "PNL",                val: fmtPnl(pnlVal),     color: isRight ? T.accent : T.positive },
        { label: "EFFECTIVE LEVERAGE", val: fmtLeverage(leverage), color: isRight ? T.accent : T.text2 },
      ];
      rows.forEach((row, i) => {
        const ry = ly + 18 + i * 18;
        setInter(10.5, "400");
        ctx.fillStyle = T.text3;
        ctx.textAlign = "left";
        ctx.fillText(row.label, startX, ry);
        setMono(10.5, "600");
        ctx.fillStyle = row.color;
        ctx.textAlign = "right";
        ctx.fillText(row.val, startX + colW, ry);
      });
      ctx.restore();
    };

    const drawCaption = (alpha: number) => {
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const cy = H * 0.88;
      setInter(Math.round(H * 0.038), "600");
      ctx.fillStyle = T.text1;
      ctx.textAlign = "center";
      ctx.fillText("LINEAR EXPOSURE IS A CHOICE.", W / 2, cy);
      setInter(Math.round(H * 0.027), "400");
      ctx.fillStyle = T.text3;
      ctx.fillText("Power perpetuals: convex payoffs, no strikes, no expiry.", W / 2, cy + H * 0.055);
      ctx.restore();
    };

    const drawTimestampHeader = (alpha: number, tsBarH: number) => {
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      setMono(10, "400");
      ctx.fillStyle = T.text3;
      ctx.textAlign = "center";
      ctx.fillText("SOL · 14:32:08 UTC · ENTRY 180.00", W / 2, tsBarH * 0.62);
      ctx.restore();
    };

    const drawPanelBorders = (layout: ReturnType<typeof getLayout>) => {
      const { divX, tsBarH, topStripH, statusH } = layout;
      ctx.save();
      ctx.strokeStyle = T.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
      ctx.beginPath(); ctx.moveTo(0, tsBarH); ctx.lineTo(W, tsBarH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(divX, tsBarH); ctx.lineTo(divX, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, tsBarH + topStripH); ctx.lineTo(W, tsBarH + topStripH); ctx.stroke();
      const sbY = H - statusH;
      ctx.beginPath(); ctx.moveTo(0, sbY); ctx.lineTo(W, sbY); ctx.stroke();
      ctx.restore();
    };

    const drawLedgerDivider = (y: number, alpha: number) => {
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = T.borderLit;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.restore();
    };

    const drawPanelFills = (tsBarH: number) => {
      ctx.fillStyle = T.surface2;
      ctx.fillRect(0, 0, W, tsBarH);
      ctx.fillStyle = T.surface;
      ctx.fillRect(0, tsBarH, W / 2, H - tsBarH);
      ctx.fillRect(W / 2 + 1, tsBarH, W / 2 - 1, H - tsBarH);
    };

    const phaseProgress = (t: number, start: number, end: number) =>
      clamp((t - start) / (end - start), 0, 1);

    let raf = 0;
    let startTime: number | null = null;
    const render = (ts: number) => {
      if (W <= 0 || H <= 0) { raf = requestAnimationFrame(render); return; }
      if (!startTime) startTime = ts;
      const t = (ts - startTime) % LOOP_DURATION;

      ctx.clearRect(0, 0, W, H);
      const layout = getLayout();
      const { tsBarH, topStripH, statusH, lp, rp } = layout;

      drawPanelFills(tsBarH);

      const lm = makeMapper(lp.chartArea);
      const rm = makeMapper(rp.chartArea);
      const linPath = buildLinearPath(lm);
      const powPath = buildPowerPath(rm);

      const ph1 = phaseProgress(t, 0, 600);
      const panelAlpha = (t >= 7000 && t < 8500)
        ? lerp(1, 0.7, easeOut(phaseProgress(t, 7000, 7200)))
        : 1;

      let currentPrice = ENTRY;
      if (t >= 1200 && t < 4400) {
        currentPrice = lerp(ENTRY, 360, easeOut(phaseProgress(t, 1200, 4400)));
      } else if (t >= 4400 && t < 6000) {
        currentPrice = 360;
      } else if (t >= 6000 && t < 6800) {
        currentPrice = lerp(360, 144, easeOut(phaseProgress(t, 6000, 6800)));
      } else if (t >= 6800 && t < 7400) {
        currentPrice = 144;
      } else if (t >= 8100) {
        currentPrice = lerp(144, 180, easeOut(phaseProgress(t, 8100, 8500)));
      }

      const linPnlVal = linearPnl(currentPrice);
      const powPnlVal = powerPnl(currentPrice);

      let dotAlpha = 0, pnlCardAlpha = 0;
      const guideAlpha = 0.25;
      if (t < 1200) {
        dotAlpha = easeOut(phaseProgress(t, 300, 1000));
        pnlCardAlpha = dotAlpha;
      } else if (t < 7400) {
        dotAlpha = 1; pnlCardAlpha = 1;
      } else {
        dotAlpha = lerp(1, 0, easeIn(phaseProgress(t, 7400, 7600)));
        pnlCardAlpha = dotAlpha;
      }

      let activeCurveProgress = 0;
      const curveRevealProgress = invlerp(PRICE_MIN, PRICE_MAX, currentPrice);
      if (t >= 1200 && t < 4400)       activeCurveProgress = curveRevealProgress;
      else if (t >= 4400 && t < 7400)  activeCurveProgress = 1.0;
      else if (t >= 8100)              activeCurveProgress = lerp(1, 0, easeOut(phaseProgress(t, 8100, 8500)));

      ctx.save();
      ctx.globalAlpha = panelAlpha;

      // LEFT chart
      ctx.save();
      ctx.beginPath();
      ctx.rect(lp.chartArea.x, lp.chartArea.y, lp.chartArea.w, lp.chartArea.h);
      ctx.clip();
      drawGrid(lp.chartArea, lm);
      drawCrosshair(lm, lp.chartArea);
      drawPathFull(linPath, T.text2, 1.5, guideAlpha);
      if (activeCurveProgress > 0) drawPathPartial(linPath, T.text2, 1.5, 1.0, activeCurveProgress);
      drawChartTag(lp.chartArea, false);
      ctx.restore();

      // RIGHT chart
      ctx.save();
      ctx.beginPath();
      ctx.rect(rp.chartArea.x, rp.chartArea.y, rp.chartArea.w, rp.chartArea.h);
      ctx.clip();
      drawGrid(rp.chartArea, rm);
      drawCrosshair(rm, rp.chartArea);
      drawPathFull(powPath, T.accent, 1.5, guideAlpha);
      if (activeCurveProgress > 0) {
        drawPowerFill(powPath, rm, 0.12, activeCurveProgress);
        drawPathPartial(powPath, T.accent, 1.5, 1.0, activeCurveProgress);
      }
      drawChartTag(rp.chartArea, true);
      ctx.restore();

      drawGridLabels(lp.chartArea, lm);
      drawGridLabels(rp.chartArea, rm);

      if (dotAlpha > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(lp.chartArea.x, lp.chartArea.y, lp.chartArea.w, lp.chartArea.h);
        ctx.clip();
        drawDot(lm.px(currentPrice), lm.py(linPnlVal), dotAlpha);
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.rect(rp.chartArea.x, rp.chartArea.y, rp.chartArea.w, rp.chartArea.h);
        ctx.clip();
        drawDot(rm.px(currentPrice), rm.py(powPnlVal), dotAlpha);
        ctx.restore();
      }

      let ceilingAlpha = 0;
      if (t >= 3600 && t < 4200) {
        if (t < 3800)      ceilingAlpha = easeOut(phaseProgress(t, 3600, 3800));
        else if (t < 4000) ceilingAlpha = 1;
        else               ceilingAlpha = lerp(1, 0, easeIn(phaseProgress(t, 4000, 4200)));
      }
      if (ceilingAlpha > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rp.chartArea.x, rp.chartArea.y, rp.chartArea.w, rp.chartArea.h);
        ctx.clip();
        drawLinearCeiling(rm, rp.chartArea, ceilingAlpha);
        ctx.restore();
      }

      drawPositionCard(lp.x, lp.y + 2, lp.w, topStripH - 4, false, currentPrice, linPnlVal, pnlCardAlpha);
      drawPositionCard(rp.x, rp.y + 2, rp.w, topStripH - 4, true,  currentPrice, powPnlVal, pnlCardAlpha);

      drawPanelBorders(layout);
      drawStatusBar(H - statusH, statusH, t);
      drawTimestampHeader(easeOut(ph1), tsBarH);

      let ledgerAlpha = 0;
      if (t >= 4400 && t < 5800) {
        if (t < 4700)      ledgerAlpha = easeOut(phaseProgress(t, 4400, 4700));
        else if (t < 5600) ledgerAlpha = 1;
        else               ledgerAlpha = lerp(1, 0, easeIn(phaseProgress(t, 5600, 5800)));
      }
      if (ledgerAlpha > 0) {
        const ly = H - statusH - 66;
        drawLedgerDivider(ly, ledgerAlpha);
        drawLedger(ly, ledgerAlpha, false, 20000, 1.0);
        drawLedger(ly, ledgerAlpha, true,  30000, 3.0);
      }

      let captionAlpha = 0;
      if (t >= 7000 && t < 8100) {
        if (t < 7500)      captionAlpha = easeOut(phaseProgress(t, 7000, 7400));
        else if (t < 7900) captionAlpha = 1;
        else               captionAlpha = lerp(1, 0, easeIn(phaseProgress(t, 7900, 8100)));
      }
      drawCaption(captionAlpha);

      let convexAnnotAlpha = 0;
      if (t >= 6500 && t < 7400) {
        if (t < 6700)      convexAnnotAlpha = easeOut(phaseProgress(t, 6500, 6700));
        else if (t < 7100) convexAnnotAlpha = 1;
        else               convexAnnotAlpha = lerp(1, 0, easeIn(phaseProgress(t, 7100, 7400)));
      }
      if (convexAnnotAlpha > 0) {
        ctx.save();
        ctx.globalAlpha = convexAnnotAlpha;
        setMono(10, "400");
        ctx.fillStyle = T.text3;
        ctx.textAlign = "left";
        ctx.fillText("CONVEXITY ASYMMETRY · LOSSES DECELERATE",
          rp.chartArea.x + 4, rp.chartArea.y + rp.chartArea.h - 14);
        ctx.restore();
      }

      ctx.restore();

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="power-perp-scene">
      <canvas ref={canvasRef} />
    </div>
  );
};
