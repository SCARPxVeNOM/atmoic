import { FC, useState, useCallback } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { useOracle, useOraclePrices } from "./hooks/useOracle";
import { usePositions } from "./hooks/usePosition";
import { useFundingRate } from "./hooks/useFundingRate";
import { useTickers } from "./hooks/useTickers";
import { IntroPage } from "./components/IntroPage";
import { ChartPanel } from "./components/ChartPanel";
import { TradePanel } from "./components/TradePanel";
import { PositionsTable } from "./components/PositionsTable";
import { DFBAView } from "./components/DFBAView";
import { PortfolioView } from "./components/PortfolioView";
import { SimplePanel } from "./components/SimplePanel";
import { TweaksPanel, Tweaks } from "./components/TweaksPanel";
import { useTradeHistory } from "./hooks/useTradeHistory";

const NAV_ITEMS = ["Trade", "DFBA", "Portfolio"] as const;
type Page = "intro" | (typeof NAV_ITEMS)[number];

const UI_MODES = ["Simple", "Standard", "Pro"] as const;
type UiMode = (typeof UI_MODES)[number];

const HEADER_MARKETS_FALLBACK = [
  { id: "SOL-USD", label: "SOL", price: 0, change: 0 },
  { id: "BTC-USD", label: "BTC", price: 0, change: 0 },
  { id: "ETH-USD", label: "ETH", price: 0, change: 0 },
];

const TWEAK_DEFAULTS: Tweaks = {
  accentColor: "#d6a84a",
  showPositions: true,
  chartInterval: "15m",
  maxLeverage: 15,
};

function PriceTag({ market, active, onClick }: {
  market: { id: string; label: string; price: number; change: number }; active: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 6, border: "1px solid",
      borderColor: active ? "rgba(255,216,116,0.42)" : "transparent",
      background: active ? "rgba(214,168,74,0.12)" : "transparent",
      cursor: "pointer",
    }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: active ? "#ffd874" : "#fff6df" }}>{market.label}</span>
      <span style={{
        fontSize: 11, fontFamily: "Geist Mono,monospace", fontWeight: 600,
        color: market.change >= 0 ? "#3fcf91" : "#ff6b6b",
      }}>{market.change >= 0 ? "+" : ""}{market.change.toFixed(1)}%</span>
    </button>
  );
}

export const App: FC = () => {
  const [page, setPage] = useState<Page>("intro");
  const [activeMarket, setActiveMarket] = useState("SOL-USD");
  const [tweaks, setTweaks] = useState<Tweaks>(TWEAK_DEFAULTS);
  const [tweaksVisible, setTweaksVisible] = useState(false);
  const [uiMode, setUiMode] = useState<UiMode>("Standard");

  const oracle = useOracle();
  const oraclePrices = useOraclePrices(["sol", "btc", "eth"]);
  const { positions } = usePositions();
  const fundingKey = activeMarket === "BTC-USD" ? "btc" : activeMarket === "ETH-USD" ? "eth" : "sol";
  const funding = useFundingRate(fundingKey);
  const tickers = useTickers();
  const tradeHistory = useTradeHistory();
  const { publicKey, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  const accent = tweaks.accentColor;
  const solPrice = oracle?.price ?? tickers?.["SOL-USD"]?.price ?? 0;

  // Live market data from Binance 24h tickers
  const headerMarkets = HEADER_MARKETS_FALLBACK.map(m => {
    const t = tickers?.[m.id];
    if (t) return { ...m, price: t.price, change: t.change24h };
    if (m.id === "SOL-USD" && solPrice) return { ...m, price: solPrice };
    return m;
  });

  const updateTweaks = useCallback((patch: Partial<Tweaks>) => {
    setTweaks(prev => ({ ...prev, ...patch }));
  }, []);

  if (page === "intro") {
    return <IntroPage onEnter={() => setPage("Trade")} />;
  }

  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "radial-gradient(circle at 22% 0%, rgba(214,168,74,0.13), transparent 32%), linear-gradient(180deg, #0d130b 0%, #070906 56%, #030403 100%)",
      color: "#fff6df",
      fontFamily: "Geist, Inter, system-ui, sans-serif",
    }}>
      {/* Header */}
      <header style={{
        height: 58, flexShrink: 0,
        borderBottom: "1px solid rgba(214,168,74,0.18)",
        display: "flex", alignItems: "center",
        padding: "0 18px", gap: 0,
        background: "linear-gradient(180deg, rgba(15,21,13,0.94), rgba(7,9,6,0.84))",
        boxShadow: "0 18px 60px rgba(0,0,0,0.26)",
        backdropFilter: "blur(18px)",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 20, cursor: "pointer" }}
          onClick={() => setPage("intro")}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="url(#idlHeaderGold)" />
            <path d="M12 4L20 18H4L12 4Z" fill="#070906" opacity="0.92" />
            <circle cx="12" cy="15" r="2" fill="#070906" opacity="0.62" />
            <defs>
              <linearGradient id="idlHeaderGold" x1="3" y1="2" x2="22" y2="23" gradientUnits="userSpaceOnUse">
                <stop stopColor="#ffe49a" />
                <stop offset="1" stopColor="#b87a22" />
              </linearGradient>
            </defs>
          </svg>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#fff6df" }}>
            IDL<span style={{ color: accent }}>Exchange</span>
          </span>
        </div>

        {/* Nav */}
        <nav style={{ display: "flex", gap: 2, marginRight: 16 }}>
          {NAV_ITEMS.map(n => (
            <button key={n} onClick={() => setPage(n)} style={{
              padding: "5px 14px", fontSize: 13, fontWeight: 500,
              borderRadius: 999, border: "none", cursor: "pointer",
              background: page === n ? "rgba(214,168,74,0.13)" : "transparent",
              color: page === n ? "#ffd874" : "rgba(255,232,177,0.58)",
              transition: "color 0.15s, background 0.15s",
            }}>{n}</button>
          ))}
        </nav>

        {/* Market tabs */}
        <div style={{ display: "flex", gap: 4, borderLeft: "1px solid rgba(214,168,74,0.18)", paddingLeft: 16 }}>
          {headerMarkets.map(m => (
            <PriceTag key={m.id}
              market={m}
              active={activeMarket === m.id && page === "Trade"}
              onClick={() => { setActiveMarket(m.id); setPage("Trade"); }}
            />
          ))}
        </div>

        {/* Right side */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {/* Mode toggle */}
          <div style={{ display: "flex", borderRadius: 999, border: "1px solid rgba(214,168,74,0.22)", overflow: "hidden", background: "rgba(255,216,116,0.035)" }}>
            {UI_MODES.map(m => (
              <button key={m} onClick={() => setUiMode(m)} style={{
                padding: "4px 10px", fontSize: 11, fontWeight: 600,
                border: "none", cursor: "pointer",
                background: uiMode === m ? "rgba(214,168,74,0.16)" : "transparent",
                color: uiMode === m ? "#ffd874" : "rgba(255,232,177,0.56)",
                transition: "all 0.15s",
              }}>{m}</button>
            ))}
          </div>

          {/* Tweaks toggle */}
          <button onClick={() => setTweaksVisible(v => !v)} style={{
            background: "rgba(255,216,116,0.035)", border: "1px solid rgba(214,168,74,0.22)", borderRadius: 999,
            padding: "4px 9px", cursor: "pointer", fontSize: 12, color: "rgba(255,232,177,0.68)",
          }} title="Tweaks">{"\u2699"}</button>

          {/* Network badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "rgba(255,232,177,0.62)" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#3fcf91", boxShadow: "0 0 9px #3fcf91" }} />
            Mainnet
          </div>

          {/* Connect wallet */}
          {publicKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, fontFamily: "Geist Mono,monospace", color: "rgba(255,232,177,0.58)" }}>
                {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
              </span>
              <button onClick={() => disconnect()} style={{
                padding: "6px 12px", background: "rgba(255,216,116,0.06)", border: "1px solid rgba(214,168,74,0.22)",
                borderRadius: 999, color: "#fff6df", fontSize: 12, cursor: "pointer",
              }}>Disconnect</button>
            </div>
          ) : (
            <button onClick={() => setVisible(true)} style={{
              padding: "7px 17px", background: "linear-gradient(135deg, #ffe49a 0%, #c28a2d 100%)", border: "none", borderRadius: 999,
              color: "#111006", fontSize: 13, fontWeight: 700, cursor: "pointer",
              boxShadow: "0 10px 34px rgba(214,168,74,0.2)",
            }}>Connect Wallet</button>
          )}
        </div>
      </header>

      {/* Workspace */}
      {page === "Trade" && uiMode === "Simple" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ width: 420, maxWidth: "100%" }}>
            <SimplePanel positions={positions} prices={oraclePrices} solPrice={solPrice} />
          </div>
        </div>
      )}

      {page === "Trade" && uiMode !== "Simple" && (
        <>
          <div style={{ flex: 1, display: "flex", minHeight: 0, padding: "12px 12px 0", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ChartPanel
                activeMarket={activeMarket}
                onMarketChange={setActiveMarket}
                solPrice={solPrice}
                fundingRate8h={funding?.rate8h}
              />
            </div>
            <TradePanel accentColor={accent} solPrice={solPrice} showProData={uiMode === "Pro"} activeMarket={activeMarket} prices={oraclePrices} />
          </div>
          {tweaks.showPositions && (
            <PositionsTable
              accentColor={accent}
              positions={positions}
              prices={oraclePrices}
              solPrice={solPrice}
              tradeHistory={tradeHistory}
            />
          )}
        </>
      )}

      {page === "DFBA" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <DFBAView accentColor={accent} solPrice={solPrice} />
        </div>
      )}

      {page === "Portfolio" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <PortfolioView accent={accent} solPrice={solPrice} position={positions[0] || null} health={null} />
        </div>
      )}

      {/* Tweaks panel */}
      {tweaksVisible && (
        <TweaksPanel tweaks={tweaks} onChange={updateTweaks} onClose={() => setTweaksVisible(false)} />
      )}
    </div>
  );
};
