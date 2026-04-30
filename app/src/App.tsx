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
  accentColor: "#a78bfa",
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
      borderColor: active ? "#30363d" : "transparent",
      background: active ? "#161b22" : "transparent",
      cursor: "pointer",
    }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "#e6edf3" }}>{market.label}</span>
      <span style={{
        fontSize: 11, fontFamily: "IBM Plex Mono,monospace", fontWeight: 600,
        color: market.change >= 0 ? "#3fb68b" : "#ff5353",
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
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0d1117" }}>
      {/* Header */}
      <header style={{
        height: 52, flexShrink: 0,
        borderBottom: "1px solid #30363d",
        display: "flex", alignItems: "center",
        padding: "0 16px", gap: 0,
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 20, cursor: "pointer" }}
          onClick={() => setPage("intro")}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill={accent} />
            <path d="M12 4L20 18H4L12 4Z" fill="#0d1117" opacity="0.9" />
            <circle cx="12" cy="15" r="2" fill="#0d1117" opacity="0.6" />
          </svg>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.03em", color: "#e6edf3" }}>
            IDL<span style={{ color: accent }}>Exchange</span>
          </span>
        </div>

        {/* Nav */}
        <nav style={{ display: "flex", gap: 2, marginRight: 16 }}>
          {NAV_ITEMS.map(n => (
            <button key={n} onClick={() => setPage(n)} style={{
              padding: "5px 14px", fontSize: 13, fontWeight: 500,
              borderRadius: 6, border: "none", cursor: "pointer",
              background: page === n ? "#21262d" : "transparent",
              color: page === n ? "#e6edf3" : "#8b949e",
              transition: "color 0.15s, background 0.15s",
            }}>{n}</button>
          ))}
        </nav>

        {/* Market tabs */}
        <div style={{ display: "flex", gap: 4, borderLeft: "1px solid #30363d", paddingLeft: 16 }}>
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
          <div style={{ display: "flex", borderRadius: 6, border: "1px solid #30363d", overflow: "hidden" }}>
            {UI_MODES.map(m => (
              <button key={m} onClick={() => setUiMode(m)} style={{
                padding: "4px 10px", fontSize: 11, fontWeight: 600,
                border: "none", cursor: "pointer",
                background: uiMode === m ? "#21262d" : "transparent",
                color: uiMode === m ? "#e6edf3" : "#8b949e",
                transition: "all 0.15s",
              }}>{m}</button>
            ))}
          </div>

          {/* Tweaks toggle */}
          <button onClick={() => setTweaksVisible(v => !v)} style={{
            background: "none", border: "1px solid #30363d", borderRadius: 6,
            padding: "4px 8px", cursor: "pointer", fontSize: 12, color: "#8b949e",
          }} title="Tweaks">{"\u2699"}</button>

          {/* Network badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#8b949e" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#3fb68b", boxShadow: "0 0 4px #3fb68b" }} />
            Mainnet
          </div>

          {/* Connect wallet */}
          {publicKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, fontFamily: "IBM Plex Mono,monospace", color: "#8b949e" }}>
                {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
              </span>
              <button onClick={() => disconnect()} style={{
                padding: "6px 12px", background: "#21262d", border: "1px solid #30363d",
                borderRadius: 8, color: "#e6edf3", fontSize: 12, cursor: "pointer",
              }}>Disconnect</button>
            </div>
          ) : (
            <button onClick={() => setVisible(true)} style={{
              padding: "6px 16px", background: accent, border: "none", borderRadius: 8,
              color: "#0d1117", fontSize: 13, fontWeight: 700, cursor: "pointer",
              letterSpacing: "-0.01em",
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
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
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
