import { useRef, useEffect, useState } from "react";
import { createChart, CandlestickData, Time, IChartApi, ISeriesApi } from "lightweight-charts";
import { useCandles } from "../hooks/useCandles";

const MARKETS = [
  { id: "SOL-USD", label: "SOL/USD" },
  { id: "BTC-USD", label: "BTC/USD" },
  { id: "ETH-USD", label: "ETH/USD" },
];

const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "4h": 14400, "1d": 86400,
};

function useCountdown(interval: string) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const ivSec = INTERVAL_SECONDS[interval] || 300;

    const tick = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const elapsed = nowSec % ivSec;
      const left = ivSec - elapsed;
      if (ivSec >= 3600) {
        const h = Math.floor(left / 3600);
        const rm = Math.floor((left % 3600) / 60);
        const rs = left % 60;
        setRemaining(`${h}:${String(rm).padStart(2, "0")}:${String(rs).padStart(2, "0")}`);
      } else {
        const m = Math.floor(left / 60);
        const s = left % 60;
        setRemaining(`${m}:${String(s).padStart(2, "0")}`);
      }
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [interval]);

  return remaining;
}

export function ChartPanel({
  activeMarket,
  onMarketChange,
  solPrice,
  fundingRate8h,
}: {
  activeMarket: string;
  onMarketChange: (id: string) => void;
  solPrice?: number;
  fundingRate8h?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLineRef = useRef<any>(null);
  const [interval, setInterval_] = useState<string>("5m");

  // Track what the chart is currently showing so we know when to fitContent
  const loadedKeyRef = useRef<string>("");

  const { candles, error } = useCandles(activeMarket, interval);
  const countdown = useCountdown(interval);

  // --- Compute accurate stats from candle data ---
  const lastCandle = candles && candles.length > 0 ? candles[candles.length - 1] : null;
  const markPrice = lastCandle?.close ?? 0;
  const indexPrice = activeMarket === "SOL-USD" && solPrice ? solPrice : markPrice;
  const displayPrice = activeMarket === "SOL-USD" && solPrice ? solPrice : markPrice;

  const candlesIn24h = Math.ceil(86400 / (INTERVAL_SECONDS[interval] || 300));
  const candle24hAgo = candles && candles.length > candlesIn24h
    ? candles[candles.length - candlesIn24h] : candles?.[0];
  const price24hAgo = candle24hAgo?.open ?? displayPrice;
  const change24h = price24hAgo > 0 ? ((displayPrice - price24hAgo) / price24hAgo) * 100 : 0;

  const recent24h = candles ? candles.slice(-candlesIn24h) : [];
  const high24h = recent24h.length > 0 ? Math.max(...recent24h.map(c => c.high)) : 0;
  const low24h = recent24h.length > 0 ? Math.min(...recent24h.map(c => c.low)) : 0;

  const vol24hUsd = recent24h.reduce((s, c) => s + (c.quoteVolume || 0), 0);
  const volStr = vol24hUsd > 1e9 ? `$${(vol24hUsd / 1e9).toFixed(2)}B`
    : vol24hUsd > 1e6 ? `$${(vol24hUsd / 1e6).toFixed(1)}M`
    : vol24hUsd > 1e3 ? `$${(vol24hUsd / 1e3).toFixed(0)}K`
    : vol24hUsd > 0 ? `$${vol24hUsd.toFixed(0)}` : "\u2014";

  // Create chart once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#0d1117" }, textColor: "#8b949e", fontSize: 11 },
      grid: { vertLines: { color: "#161b22" }, horzLines: { color: "#161b22" } },
      crosshair: {
        mode: 1,
        vertLine: { color: "#30363d" },
        horzLine: { color: "#30363d" },
      },
      rightPriceScale: { borderColor: "#30363d", autoScale: true },
      timeScale: { borderColor: "#30363d", timeVisible: true, secondsVisible: false },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#3fb68b", downColor: "#ff5353",
      borderUpColor: "#3fb68b", borderDownColor: "#ff5353",
      wickUpColor: "#3fb68b", wickDownColor: "#ff5353",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  // Update data when candles arrive
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    // candles is null while loading new pair — clear the chart
    if (!candles || candles.length === 0) {
      seriesRef.current.setData([]);
      if (priceLineRef.current) {
        seriesRef.current.removePriceLine(priceLineRef.current);
        priceLineRef.current = null;
      }
      return;
    }

    const data: CandlestickData<Time>[] = candles.map(c => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    seriesRef.current.setData(data);

    // Only fitContent when market/interval changed (not on refresh polls)
    const newKey = `${activeMarket}_${interval}`;
    if (loadedKeyRef.current !== newKey) {
      loadedKeyRef.current = newKey;
      // Use requestAnimationFrame to ensure data is rendered before fitting
      requestAnimationFrame(() => {
        chartRef.current?.timeScale().fitContent();
      });
    }
  }, [candles, activeMarket, interval]);

  // Update mark price line
  useEffect(() => {
    if (!seriesRef.current || !displayPrice) return;
    if (priceLineRef.current) {
      seriesRef.current.removePriceLine(priceLineRef.current);
    }
    priceLineRef.current = seriesRef.current.createPriceLine({
      price: displayPrice,
      color: "#58a6ff",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "Mark",
    });
  }, [displayPrice, candles]);

  const fmt = (n: number) => n >= 10000
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n >= 1 ? n.toFixed(2) : n.toFixed(4);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0d1117" }}>
      {/* Stats bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, padding: "0 16px",
        height: 44, borderBottom: "1px solid #30363d", flexShrink: 0,
      }}>
        <div style={{ display: "flex", gap: 2 }}>
          {MARKETS.map(m => (
            <button key={m.id} onClick={() => onMarketChange(m.id)} style={{
              padding: "4px 12px", fontSize: 12, fontWeight: 500,
              borderRadius: 6, border: "none", cursor: "pointer",
              background: activeMarket === m.id ? "#21262d" : "transparent",
              color: activeMarket === m.id ? "#e6edf3" : "#8b949e",
            }}>{m.label}</button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{
            fontSize: 20, fontWeight: 700,
            fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3", letterSpacing: "-0.02em",
          }}>${fmt(displayPrice)}</span>
          <span style={{
            fontSize: 12, fontFamily: "IBM Plex Mono,monospace", fontWeight: 600,
            color: change24h >= 0 ? "#3fb68b" : "#ff5353",
          }}>{change24h >= 0 ? "+" : ""}{change24h.toFixed(2)}%</span>
        </div>

        <div style={{ display: "flex", gap: 18, fontSize: 11, color: "#8b949e" }}>
          {([
            ["Mark", `$${fmt(markPrice)}`, "#58a6ff"],
            ["Index", `$${fmt(indexPrice)}`, "#e6edf3"],
            ["Funding", fundingRate8h != null ? `${fundingRate8h >= 0 ? "+" : ""}${fundingRate8h.toFixed(4)}%/8h` : "\u2014", fundingRate8h != null && fundingRate8h >= 0 ? "#3fb68b" : "#ff5353"],
            ["24h Vol", volStr, "#e6edf3"],
            ["24h High", high24h > 0 ? `$${fmt(high24h)}` : "\u2014", "#3fb68b"],
            ["24h Low", low24h > 0 ? `$${fmt(low24h)}` : "\u2014", "#ff5353"],
          ] as [string, string, string][]).map(([lbl, val, col]) => (
            <span key={lbl}>
              {lbl}{" "}
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: col, fontWeight: 500 }}>{val}</span>
            </span>
          ))}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          {INTERVALS.map(iv => (
            <button key={iv} onClick={() => setInterval_(iv)} style={{
              padding: "3px 8px", fontSize: 10, fontWeight: 600,
              borderRadius: 4, border: "none", cursor: "pointer",
              background: interval === iv ? "#21262d" : "transparent",
              color: interval === iv ? "#e6edf3" : "#8b949e",
            }}>{iv}</button>
          ))}
        </div>
      </div>

      {/* Countdown timer bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "flex-end",
        padding: "0 16px", height: 22, borderBottom: "1px solid #161b22",
        fontSize: 10, fontFamily: "IBM Plex Mono,monospace", color: "#8b949e",
        gap: 12,
      }}>
        <span>
          Next candle{" "}
          <span style={{ color: "#58a6ff", fontWeight: 600 }}>{countdown}</span>
        </span>
        {error && <span style={{ color: "#ff5353" }}>Offline</span>}
        {!error && candles && <span style={{ color: "#3fb68b" }}>{"\u25CF"} Live</span>}
      </div>

      {/* Loading state */}
      {!candles && !error && (
        <div style={{
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, color: "#8b949e",
        }}>
          Loading {MARKETS.find(m => m.id === activeMarket)?.label} chart...
        </div>
      )}

      {/* Chart canvas */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, display: candles ? undefined : "none" }} />
    </div>
  );
}
