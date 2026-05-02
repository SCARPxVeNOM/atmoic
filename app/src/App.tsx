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
      display: "flex", alignItems: "center", gap: 8,
      padding: "5px 12px", borderRadius: 4,
      border: `1px solid ${active ? "#26262e" : "transparent"}`,
      background: active ? "#111114" : "transparent",
      cursor: "pointer",
      transition: "background 0.15s, border-color 0.15s",
    }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: active ? "#ffffff" : "#8b8b94", letterSpacing: 0.2 }}>{market.label}</span>
      <span style={{
        fontSize: 11, fontFamily: "JetBrains Mono, Geist Mono, monospace", fontWeight: 500,
        color: market.change >= 0 ? "#22c55e" : "#ef4444", fontVariantNumeric: "tabular-nums",
      }}>{market.change >= 0 ? "+" : ""}{market.change.toFixed(2)}%</span>
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
      background: "#000",
      color: "#ffffff",
      fontFamily: "Inter, system-ui, sans-serif",
    }}>
      {/* Header */}
      <header style={{
        height: 56, flexShrink: 0,
        borderBottom: "1px solid #1a1a1f",
        display: "flex", alignItems: "center",
        padding: "0 20px", gap: 0,
        background: "#000",
      }}>
        {/* Logo */}
        <button onClick={() => setPage("intro")} style={{
          display: "flex", alignItems: "center", gap: 10, marginRight: 28,
          background: "transparent", border: 0, padding: 0, cursor: "pointer",
        }}>
          <img
            src="/assets/54gP3tTm_400x400.jpg"
            alt="IDLExchange"
            width={26}
            height={26}
            style={{ display: "block", borderRadius: 4, objectFit: "cover" }}
          />
          <span style={{ fontSize: 14, fontWeight: 600, color: "#ffffff", letterSpacing: -0.2 }}>
            IDL<span style={{ color: "#e2b85d" }}>Exchange</span>
          </span>
        </button>

        {/* Nav \u2014 underline-style */}
        <nav style={{ display: "flex", gap: 4, marginRight: 24, alignSelf: "stretch", alignItems: "stretch" }}>
          {NAV_ITEMS.map(n => {
            const active = page === n;
            return (
              <button key={n} onClick={() => setPage(n)} style={{
                position: "relative",
                padding: "0 14px", fontSize: 13, fontWeight: 500,
                border: 0, background: "transparent", cursor: "pointer",
                color: active ? "#ffffff" : "#8b8b94",
                transition: "color 0.15s",
              }}>
                {n}
                {active && (
                  <span style={{
                    position: "absolute", left: 12, right: 12, bottom: -1, height: 2,
                    background: "#e2b85d",
                  }} />
                )}
              </button>
            );
          })}
        </nav>

        {/* Market tabs */}
        <div style={{ display: "flex", gap: 4, borderLeft: "1px solid #1a1a1f", paddingLeft: 16 }}>
          {headerMarkets.map(m => (
            <PriceTag key={m.id}
              market={m}
              active={activeMarket === m.id && page === "Trade"}
              onClick={() => { setActiveMarket(m.id); setPage("Trade"); }}
            />
          ))}
        </div>

        {/* Right side */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {/* Mode toggle */}
          <div style={{ display: "flex", borderRadius: 4, border: "1px solid #1a1a1f", overflow: "hidden", background: "#0a0a0b" }}>
            {UI_MODES.map(m => (
              <button key={m} onClick={() => setUiMode(m)} style={{
                padding: "5px 11px", fontSize: 11, fontWeight: 500,
                border: 0, cursor: "pointer",
                background: uiMode === m ? "#111114" : "transparent",
                color: uiMode === m ? "#ffffff" : "#8b8b94",
                transition: "background 0.15s, color 0.15s",
              }}>{m}</button>
            ))}
          </div>

          {/* Tweaks toggle */}
          <button onClick={() => setTweaksVisible(v => !v)} style={{
            background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 4,
            width: 28, height: 28, display: "grid", placeItems: "center",
            cursor: "pointer", fontSize: 13, color: "#8b8b94",
          }} title="Tweaks">{"\u2699"}</button>

          {/* Network badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#8b8b94", marginLeft: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e" }} />
            Mainnet
          </div>

          {/* Connect wallet */}
          {publicKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                fontSize: 11, fontFamily: "JetBrains Mono, Geist Mono, monospace",
                color: "#8b8b94", padding: "5px 10px",
                border: "1px solid #1a1a1f", borderRadius: 4, background: "#0a0a0b",
              }}>
                {publicKey.toBase58().slice(0, 4)}\u2026{publicKey.toBase58().slice(-4)}
              </span>
              <button onClick={() => disconnect()} style={{
                padding: "6px 12px", background: "transparent", border: "1px solid #1a1a1f",
                borderRadius: 4, color: "#ffffff", fontSize: 12, cursor: "pointer",
                transition: "border-color 0.15s",
              }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#26262e")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1a1a1f")}
              >Disconnect</button>
            </div>
          ) : (
            <button onClick={() => setVisible(true)} style={{
              padding: "7px 16px", background: "#e2b85d", border: 0, borderRadius: 4,
              color: "#000", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
              letterSpacing: 0.1,
              transition: "background 0.15s",
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#ffe18a")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#e2b85d")}
            >Connect Wallet</button>
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
