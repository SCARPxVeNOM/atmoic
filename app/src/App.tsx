import { FC, useState, useCallback } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { useOracle, useOraclePrices } from "./hooks/useOracle";
import { usePositions } from "./hooks/usePosition";
import { useFundingRate } from "./hooks/useFundingRate";
import { useTickers } from "./hooks/useTickers";
import { useIsMobile } from "./hooks/useIsMobile";
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
  showPositions: true,
};

function PriceTag({ market, active, onClick, compact }: {
  market: { id: string; label: string; price: number; change: number }; active: boolean; onClick: () => void; compact?: boolean;
}) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: compact ? 4 : 8,
      padding: compact ? "4px 8px" : "5px 12px", borderRadius: 4,
      border: `1px solid ${active ? "#26262e" : "transparent"}`,
      background: active ? "#111114" : "transparent",
      cursor: "pointer",
      transition: "background 0.15s, border-color 0.15s",
    }}>
      <span style={{ fontSize: compact ? 11 : 12, fontWeight: 600, color: active ? "#ffffff" : "#8b8b94", letterSpacing: 0.2 }}>{market.label}</span>
      <span style={{
        fontSize: compact ? 10 : 11, fontFamily: "JetBrains Mono, Geist Mono, monospace", fontWeight: 500,
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
  const isMobile = useIsMobile();

  const oracle = useOracle();
  const oraclePrices = useOraclePrices(["sol", "btc", "eth"]);
  const { positions } = usePositions();
  const fundingKey = activeMarket === "BTC-USD" ? "btc" : activeMarket === "ETH-USD" ? "eth" : "sol";
  const funding = useFundingRate(fundingKey);
  const tickers = useTickers();
  const tradeHistory = useTradeHistory();
  const { publicKey, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  const accent = "#e2b85d";
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
      overflow: isMobile ? "auto" : undefined,
    }}>
      {/* Header */}
      <header style={{
        flexShrink: 0,
        borderBottom: "1px solid #1a1a1f",
        display: "flex", flexWrap: isMobile ? "wrap" : "nowrap", alignItems: "center",
        padding: isMobile ? "8px 12px" : "0 20px",
        gap: isMobile ? 8 : 0,
        background: "#000",
        minHeight: isMobile ? undefined : 56,
      }}>
        {/* Logo */}
        <button onClick={() => setPage("intro")} style={{
          display: "flex", alignItems: "center", gap: 8, marginRight: isMobile ? "auto" : 28,
          background: "transparent", border: 0, padding: 0, cursor: "pointer",
        }}>
          <img
            src="/assets/54gP3tTm_400x400.jpg"
            alt="IDLExchange"
            width={isMobile ? 22 : 26}
            height={isMobile ? 22 : 26}
            style={{ display: "block", borderRadius: 4, objectFit: "cover" }}
          />
          <span style={{ fontSize: isMobile ? 13 : 14, fontWeight: 600, color: "#ffffff", letterSpacing: -0.2 }}>
            IDL<span style={{ color: "#e2b85d" }}>Exchange</span>
          </span>
        </button>

        {/* Mobile: wallet button in header row */}
        {isMobile && (
          publicKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                fontSize: 10, fontFamily: "JetBrains Mono, Geist Mono, monospace",
                color: "#8b8b94", padding: "4px 8px",
                border: "1px solid #1a1a1f", borderRadius: 4, background: "#0a0a0b",
              }}>
                {publicKey.toBase58().slice(0, 4)}{"\u2026"}{publicKey.toBase58().slice(-4)}
              </span>
              <button onClick={() => disconnect()} style={{
                padding: "4px 8px", background: "transparent", border: "1px solid #1a1a1f",
                borderRadius: 4, color: "#8b8b94", fontSize: 10, cursor: "pointer",
              }}>×</button>
            </div>
          ) : (
            <button onClick={() => setVisible(true)} style={{
              padding: "5px 12px", background: "#e2b85d", border: 0, borderRadius: 4,
              color: "#000", fontSize: 11, fontWeight: 600, cursor: "pointer",
            }}>Connect</button>
          )
        )}

        {/* Second row on mobile: nav + markets */}
        <div style={{
          display: "flex", alignItems: "center", gap: isMobile ? 4 : 0,
          width: isMobile ? "100%" : undefined,
          overflowX: isMobile ? "auto" : undefined,
          flexShrink: 0,
        }}>
          {/* Nav */}
          <nav style={{
            display: "flex", gap: isMobile ? 2 : 4,
            marginRight: isMobile ? 8 : 24,
            alignSelf: "stretch", alignItems: "stretch",
          }}>
            {NAV_ITEMS.map(n => {
              const active = page === n;
              return (
                <button key={n} onClick={() => setPage(n)} style={{
                  position: "relative",
                  padding: isMobile ? "6px 10px" : "0 14px",
                  fontSize: isMobile ? 12 : 13, fontWeight: 500,
                  border: 0, background: "transparent", cursor: "pointer",
                  color: active ? "#ffffff" : "#8b8b94",
                  transition: "color 0.15s",
                  whiteSpace: "nowrap",
                }}>
                  {n}
                  {active && (
                    <span style={{
                      position: "absolute", left: isMobile ? 8 : 12, right: isMobile ? 8 : 12, bottom: -1, height: 2,
                      background: "#e2b85d",
                    }} />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Market tabs */}
          <div style={{
            display: "flex", gap: 2,
            borderLeft: isMobile ? "none" : "1px solid #1a1a1f",
            paddingLeft: isMobile ? 0 : 16,
          }}>
            {headerMarkets.map(m => (
              <PriceTag key={m.id}
                market={m}
                active={activeMarket === m.id && page === "Trade"}
                onClick={() => { setActiveMarket(m.id); setPage("Trade"); }}
                compact={isMobile}
              />
            ))}
          </div>

          {/* Mode toggle — desktop only in this row */}
          {!isMobile && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
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

              <button onClick={() => setTweaksVisible(v => !v)} style={{
                background: "#0a0a0b", border: "1px solid #1a1a1f", borderRadius: 4,
                width: 28, height: 28, display: "grid", placeItems: "center",
                cursor: "pointer", fontSize: 13, color: "#8b8b94",
              }} title="Tweaks">{"\u2699"}</button>

              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#8b8b94", marginLeft: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e" }} />
                Mainnet
              </div>

              {publicKey ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    fontSize: 11, fontFamily: "JetBrains Mono, Geist Mono, monospace",
                    color: "#8b8b94", padding: "5px 10px",
                    border: "1px solid #1a1a1f", borderRadius: 4, background: "#0a0a0b",
                  }}>
                    {publicKey.toBase58().slice(0, 4)}{"\u2026"}{publicKey.toBase58().slice(-4)}
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
          )}
        </div>
      </header>

      {/* Workspace */}
      {page === "Trade" && (isMobile || uiMode === "Simple") && (
        <div style={{
          flex: 1, minHeight: 0,
          display: "flex", alignItems: isMobile ? "stretch" : "center",
          justifyContent: "center",
          padding: isMobile ? 0 : 24,
          flexDirection: "column",
          overflow: isMobile ? "auto" : undefined,
        }}>
          <div style={{ width: isMobile ? "100%" : 420, maxWidth: "100%", margin: isMobile ? 0 : "0 auto" }}>
            {isMobile && uiMode !== "Simple" ? (
              <>
                {/* Mobile: chart then trade panel stacked */}
                <div style={{ height: 280, borderBottom: "1px solid #1a1a1f" }}>
                  <ChartPanel
                    activeMarket={activeMarket}
                    onMarketChange={setActiveMarket}
                    solPrice={solPrice}
                    fundingRate8h={funding?.rate8h}
                  />
                </div>
                <TradePanel accentColor={accent} solPrice={solPrice} showProData={uiMode === "Pro"} activeMarket={activeMarket} prices={oraclePrices} />
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
            ) : (
              <SimplePanel positions={positions} prices={oraclePrices} solPrice={solPrice} />
            )}
          </div>
        </div>
      )}

      {page === "Trade" && !isMobile && uiMode !== "Simple" && (
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
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: isMobile ? "auto" : undefined }}>
          <DFBAView accentColor={accent} solPrice={solPrice} />
        </div>
      )}

      {page === "Portfolio" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: isMobile ? "auto" : undefined }}>
          <PortfolioView accent={accent} solPrice={solPrice} positions={positions} prices={oraclePrices} />
        </div>
      )}

      {/* Tweaks panel */}
      {tweaksVisible && (
        <TweaksPanel tweaks={tweaks} onChange={updateTweaks} onClose={() => setTweaksVisible(false)} />
      )}
    </div>
  );
};
