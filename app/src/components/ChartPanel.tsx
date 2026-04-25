import { useRef, useEffect, useMemo } from "react";
import { createChart, CandlestickData, Time } from "lightweight-charts";

interface Market {
  id: string;
  label: string;
  base: number;
  change: number;
  vol: string;
}

const MARKETS: Market[] = [
  { id: "SOL-USD", label: "SOL/USD", base: 142.30, change: 2.4, vol: "1.24B" },
  { id: "BTC-USD", label: "BTC/USD", base: 97480, change: -0.8, vol: "8.71B" },
  { id: "ETH-USD", label: "ETH/USD", base: 3241, change: 1.2, vol: "2.18B" },
];

function generateCandles(basePrice: number, count: number): CandlestickData<Time>[] {
  const out: CandlestickData<Time>[] = [];
  let price = basePrice * 0.93;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < count; i++) {
    const t = (now - (count - i) * 300) as Time;
    const drift = (Math.random() - 0.476) * basePrice * 0.004;
    const open = price;
    price = Math.max(basePrice * 0.78, Math.min(basePrice * 1.15, price + drift));
    const swing = basePrice * 0.0015;
    const high = Math.max(open, price) + Math.random() * swing;
    const low = Math.min(open, price) - Math.random() * swing;
    out.push({ time: t, open, high, low, close: price });
  }
  const last = out[out.length - 1];
  last.close = basePrice;
  last.high = Math.max(last.high, basePrice);
  return out;
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

  const market = MARKETS.find(m => m.id === activeMarket) || MARKETS[0];
  const displayPrice = activeMarket === "SOL-USD" && solPrice ? solPrice : market.base;

  const candles = useMemo(() => generateCandles(market.base, 320), [activeMarket]);

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
      rightPriceScale: { borderColor: "#30363d" },
      timeScale: { borderColor: "#30363d", timeVisible: true, secondsVisible: false },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#3fb68b", downColor: "#ff5353",
      borderUpColor: "#3fb68b", borderDownColor: "#ff5353",
      wickUpColor: "#3fb68b", wickDownColor: "#ff5353",
    });

    series.setData(candles);

    series.createPriceLine({
      price: market.base,
      color: "#58a6ff",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "Mark",
    });

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); };
  }, [activeMarket, candles, market.base]);

  const fmt = (n: number) => n >= 1000
    ? n.toLocaleString("en-US", { minimumFractionDigits: 0 })
    : n.toFixed(2);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0d1117" }}>
      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, padding: "0 16px",
        height: 44, borderBottom: "1px solid #30363d", flexShrink: 0,
      }}>
        {/* Market tabs */}
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

        {/* Price */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{
            fontSize: 20, fontWeight: 700,
            fontFamily: "IBM Plex Mono,monospace", color: "#e6edf3", letterSpacing: "-0.02em",
          }}>${fmt(displayPrice)}</span>
          <span style={{
            fontSize: 12, fontFamily: "IBM Plex Mono,monospace", fontWeight: 600,
            color: market.change >= 0 ? "#3fb68b" : "#ff5353",
          }}>{market.change >= 0 ? "+" : ""}{market.change}%</span>
        </div>

        {/* Stats */}
        <div style={{ marginLeft: 8, display: "flex", gap: 20, fontSize: 11, color: "#8b949e" }}>
          {([
            ["Mark", `$${fmt(displayPrice)}`, "#58a6ff"],
            ["Index", `$${fmt(displayPrice * 1.0003)}`, "#e6edf3"],
            ["Funding", fundingRate8h != null ? `${fundingRate8h >= 0 ? "+" : ""}${fundingRate8h.toFixed(4)}%/8h` : "—", fundingRate8h != null && fundingRate8h >= 0 ? "#3fb68b" : "#ff5353"],
            ["24h Vol", market.vol, "#e6edf3"],
          ] as [string, string, string][]).map(([lbl, val, col]) => (
            <span key={lbl}>
              {lbl}{" "}
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: col, fontWeight: 500 }}>{val}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Chart canvas */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
