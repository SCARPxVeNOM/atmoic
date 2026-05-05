import { useBatchQueue } from "../hooks/useBatchQueue";
import { useIsMobile } from "../hooks/useIsMobile";

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(n < 10 ? 2 : 0);
}

function fmtPrice(n: number) {
  if (n >= 1000) return n.toFixed(2);
  return n.toFixed(4);
}

interface Props {
  activeMarket: string;
  solPrice?: number;
}

export function OrderBook({ activeMarket, solPrice }: Props) {
  const queue = useBatchQueue();
  const isMobile = useIsMobile();

  const oraclePrice = queue?.oraclePrice || solPrice || 0;

  // Generate synthetic depth levels around oracle price if no real orders
  const bids = queue?.bidOrders?.length
    ? queue.bidOrders
    : generateSyntheticLevels(oraclePrice, "bid", 8);
  const asks = queue?.askOrders?.length
    ? queue.askOrders
    : generateSyntheticLevels(oraclePrice, "ask", 8);

  // Take top 8 levels each
  const displayBids = bids.slice(0, 8);
  const displayAsks = asks.slice(0, 8);

  // Max size for bar scaling
  const allSizes = [...displayBids.map(o => o.size), ...displayAsks.map(o => o.size)];
  const maxSize = Math.max(...allSizes, 1);

  // Cumulative sizes
  let bidCum = 0;
  const bidsWithCum = displayBids.map(o => {
    bidCum += o.size;
    return { ...o, cumSize: bidCum };
  });
  let askCum = 0;
  const asksWithCum = displayAsks.map(o => {
    askCum += o.size;
    return { ...o, cumSize: askCum };
  });

  const maxCum = Math.max(bidCum, askCum, 1);

  const spread = displayAsks.length > 0 && displayBids.length > 0
    ? displayAsks[0].price - displayBids[0].price
    : 0;
  const spreadPct = oraclePrice > 0 ? (spread / oraclePrice) * 100 : 0;

  return (
    <div style={{
      width: isMobile ? "100%" : 200,
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      background: "#0a0a0b",
      border: "1px solid #1a1a1f",
      borderRadius: 0,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "8px 10px",
        borderBottom: "1px solid #1a1a1f",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#ffffff" }}>Order Book</span>
        <span style={{ fontSize: 9, color: "#8b949e", textTransform: "uppercase" }}>
          {activeMarket.replace("-USD", "").replace("-PERP", "")}
        </span>
      </div>

      {/* Column headers */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 10px",
        borderBottom: "1px solid #1a1a1f",
        fontSize: 9,
        color: "#8b949e",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}>
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>

      {/* Asks (reversed so lowest ask is at bottom, near spread) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", minHeight: 0, overflow: "hidden" }}>
        {[...asksWithCum].reverse().map((o, i) => (
          <div key={`a-${i}`} style={{ position: "relative", padding: "3px 10px" }}>
            <div style={{
              position: "absolute", top: 0, bottom: 0, right: 0,
              width: `${(o.cumSize / maxCum) * 100}%`,
              background: "rgba(255,83,83,0.06)",
            }} />
            <div style={{ display: "flex", justifyContent: "space-between", position: "relative", fontSize: 11 }}>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#ff5353", fontVariantNumeric: "tabular-nums" }}>
                {fmtPrice(o.price)}
              </span>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#c9d1d9", fontVariantNumeric: "tabular-nums" }}>
                {fmt(o.size)}
              </span>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#8b949e", fontVariantNumeric: "tabular-nums", fontSize: 10 }}>
                {fmt(o.cumSize)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Spread / Oracle price center */}
      <div style={{
        padding: "6px 10px",
        borderTop: "1px solid #1a1a1f",
        borderBottom: "1px solid #1a1a1f",
        background: "#111114",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span style={{
          fontSize: 13,
          fontFamily: "IBM Plex Mono,monospace",
          fontWeight: 700,
          color: "#ffffff",
        }}>
          {fmtPrice(oraclePrice)}
        </span>
        <span style={{ fontSize: 9, color: "#8b949e" }}>
          {spread > 0 ? `${spreadPct.toFixed(3)}% spread` : "Oracle"}
        </span>
      </div>

      {/* Bids */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
        {bidsWithCum.map((o, i) => (
          <div key={`b-${i}`} style={{ position: "relative", padding: "3px 10px" }}>
            <div style={{
              position: "absolute", top: 0, bottom: 0, right: 0,
              width: `${(o.cumSize / maxCum) * 100}%`,
              background: "rgba(63,182,139,0.06)",
            }} />
            <div style={{ display: "flex", justifyContent: "space-between", position: "relative", fontSize: 11 }}>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#3fb68b", fontVariantNumeric: "tabular-nums" }}>
                {fmtPrice(o.price)}
              </span>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#c9d1d9", fontVariantNumeric: "tabular-nums" }}>
                {fmt(o.size)}
              </span>
              <span style={{ fontFamily: "IBM Plex Mono,monospace", color: "#8b949e", fontVariantNumeric: "tabular-nums", fontSize: 10 }}>
                {fmt(o.cumSize)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Footer - batch info */}
      {queue && (
        <div style={{
          padding: "6px 10px",
          borderTop: "1px solid #1a1a1f",
          display: "flex",
          justifyContent: "space-between",
          fontSize: 9,
          color: "#8b949e",
        }}>
          <span>{queue.bids + queue.asks} orders</span>
          {queue.clearingPrice > 0 && (
            <span>Last: ${fmtPrice(queue.clearingPrice)}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Generate synthetic order book levels around oracle price for visual depth */
function generateSyntheticLevels(
  oraclePrice: number,
  side: "bid" | "ask",
  count: number,
): { price: number; size: number }[] {
  if (oraclePrice <= 0) return [];

  const levels: { price: number; size: number }[] = [];
  const stepPct = 0.001; // 0.1% per level

  for (let i = 1; i <= count; i++) {
    const offset = oraclePrice * stepPct * i;
    const price = side === "bid" ? oraclePrice - offset : oraclePrice + offset;
    // Size increases with distance from oracle (deeper levels have more liquidity)
    const baseSize = 50 + Math.random() * 100;
    const size = Math.round(baseSize * (1 + i * 0.3));
    levels.push({ price: Math.round(price * 1e4) / 1e4, size });
  }

  return levels;
}
