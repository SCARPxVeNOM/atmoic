import { FC, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { PositionView } from "../hooks/usePosition";
import { useBatchQueue } from "../hooks/useBatchQueue";
import { useFundingRate } from "../hooks/useFundingRate";
import { API_BASE } from "../config";
import { describeTransaction } from "../lib/tx-description";

interface VaultRisk {
  spreadBps: number;
  skewPct: number;
  suspended: boolean;
}

export const ProPanel: FC<{
  position: PositionView | null;
  solPrice: number;
  onConfirming?: () => void;
  onConfirmed?: () => void;
}> = ({ position, solPrice, onConfirming, onConfirmed }) => {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const batchQueue = useBatchQueue();
  const funding = useFundingRate();
  const [collateral, setCollateral] = useState("0.1");
  const [leverage, setLeverage] = useState(5);
  const [side, setSide] = useState<"Long" | "Short">("Long");
  const [market, setMarket] = useState("SOL-PERP");
  const [hedgePct, setHedgePct] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [vaultRisk, setVaultRisk] = useState<VaultRisk | null>(null);
  const [confirmDesc, setConfirmDesc] = useState<string | null>(null);
  const [pendingSide, setPendingSide] = useState<"Long" | "Short">("Long");
  const [optimistic, setOptimistic] = useState<{ side: string; value: number } | null>(null);
  const [orderPrice, setOrderPrice] = useState("");
  const [orderSize, setOrderSize] = useState("");
  const [orderBusy, setOrderBusy] = useState(false);
  const [crankStatus, setCrankStatus] = useState<{ batchesExecuted: number } | null>(null);
  const [fundingHistory, setFundingHistory] = useState<{ timestamp: number; price: number; rate: number }[]>([]);

  // Fetch vault risk on mount
  useEffect(() => {
    fetch(`${API_BASE}/vault/risk`)
      .then(r => r.json())
      .then(setVaultRisk)
      .catch(() => {});
  }, []);

  // Poll crank status every 5s
  useEffect(() => {
    const poll = () => {
      fetch(`${API_BASE}/crank/status`).then(r => r.json()).then(setCrankStatus).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // Fetch funding history on mount
  useEffect(() => {
    fetch(`${API_BASE}/funding/history`)
      .then(r => r.json())
      .then(setFundingHistory)
      .catch(() => {});
  }, []);

  const notional = Number(collateral) * solPrice * leverage;

  const sendTx = async (endpoint: string, body: any) => {
    if (!publicKey || !signTransaction) throw new Error("Connect wallet");
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "build failed");
    const { tx: b64 } = await res.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  };

  const requestOpen = (s: "Long" | "Short") => {
    setPendingSide(s);
    setSide(s);
    const desc = describeTransaction({
      type: "open",
      side: s,
      collateralSol: Number(collateral),
      leverage,
      solPrice,
    });
    setConfirmDesc(desc);
  };

  const onOpen = async () => {
    if (!publicKey) return;
    setConfirmDesc(null);
    setBusy(true);
    setStatus(null);
    setOptimistic({ side, value: Number(collateral) * solPrice * leverage });
    onConfirming?.();
    try {
      const lamports = BigInt(Math.floor(Number(collateral) * 1e9));
      const borrow = BigInt(Math.floor(Number(collateral) * solPrice * (leverage - 1) * 1e6));
      const hedgeAmount = BigInt(Math.floor(Number(borrow) * hedgePct / 100));
      const sig = await sendTx("/build-tx/open", {
        wallet: publicKey.toBase58(),
        collateralAmount: lamports.toString(),
        borrowAmount: borrow.toString(),
        side,
        leverageBps: leverage * 1000,
        hedgeAmount: hedgeAmount.toString(),
        useKamino: true,
        market,
      });
      setStatus(`Opened: ${sig.slice(0, 8)}...`);
      setOptimistic(null);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
      setOptimistic(null);
    } finally {
      setBusy(false);
      onConfirmed?.();
    }
  };

  const onClose = async () => {
    if (!publicKey) return;
    setBusy(true);
    setStatus(null);
    try {
      const sig = await sendTx("/build-tx/close", { wallet: publicKey.toBase58(), useKamino: true, market });
      setStatus(`Closed: ${sig.slice(0, 8)}...`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const placeOrder = async (orderSide: "Long" | "Short") => {
    if (!publicKey || !orderPrice || !orderSize) return;
    setOrderBusy(true);
    try {
      const sig = await sendTx("/build-tx/place-order", {
        wallet: publicKey.toBase58(),
        price: BigInt(Math.floor(Number(orderPrice) * 1e6)).toString(),
        size: BigInt(Math.floor(Number(orderSize) * 1e9)).toString(),
        side: orderSide,
        market,
      });
      setStatus(`Order placed: ${sig.slice(0, 8)}...`);
      setOrderPrice("");
      setOrderSize("");
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setOrderBusy(false);
    }
  };

  const cancelOrder = async () => {
    if (!publicKey) return;
    setOrderBusy(true);
    try {
      const sig = await sendTx("/build-tx/cancel-order", {
        wallet: publicKey.toBase58(),
        market,
      });
      setStatus(`Order cancelled: ${sig.slice(0, 8)}...`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setOrderBusy(false);
    }
  };

  return (
    <div className="border border-slate-800 rounded-xl p-4 space-y-4">
      {/* Header + Market Selector */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Pro Trading</span>
        <div className="flex gap-1">
          {["SOL-PERP", "BTC-PERP", "ETH-PERP"].map(m => (
            <button
              key={m}
              onClick={() => setMarket(m)}
              className={`px-2 py-0.5 text-xs rounded font-mono ${
                market === m ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400"
              }`}
            >
              {m.split("-")[0]}
            </button>
          ))}
        </div>
      </div>

      {/* Vault & Funding Info */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-slate-900 rounded p-2">
          <div className="text-slate-500">Spread</div>
          <div className="font-mono text-slate-300">
            {vaultRisk?.suspended ? (
              <span className="text-red-400">SUSPENDED (&gt;90% skew)</span>
            ) : (
              <>
                {vaultRisk?.spreadBps ?? "—"} bps
                <span className="text-slate-600 ml-1 text-[10px]">
                  T{(() => {
                    const s = vaultRisk?.skewPct ?? 0;
                    if (s <= 30) return "1";
                    if (s <= 55) return "2";
                    if (s <= 75) return "3";
                    if (s <= 90) return "4";
                    return "X";
                  })()}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="bg-slate-900 rounded p-2">
          <div className="text-slate-500">Skew</div>
          <div className="font-mono text-slate-300">{vaultRisk?.skewPct ?? 0}%</div>
        </div>
        <div className="bg-slate-900 rounded p-2">
          <div className="text-slate-500">Funding (8h)</div>
          <div className="font-mono text-slate-300">
            {funding ? `${funding.rate8h.toFixed(4)}%` : "—"}
          </div>
        </div>
      </div>

      {/* Batch Queue Status */}
      {batchQueue && (
        <div className="flex items-center justify-between text-xs bg-slate-900/50 rounded p-2">
          <span className="text-slate-500">Batch Queue</span>
          <span className="font-mono text-slate-400">
            {batchQueue.bids}B / {batchQueue.asks}A
          </span>
          <span className="font-mono text-slate-400">
            Last: {new Date(batchQueue.lastBatchAt).toLocaleTimeString()}
          </span>
        </div>
      )}

      {/* DFBA Order Book */}
      <div className="border border-slate-800 rounded p-3 space-y-2">
        <div className="text-xs font-semibold text-slate-400">DFBA Order Book</div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="text-green-400 font-mono">Bids: {batchQueue?.bids ?? 0}</div>
          <div className="text-red-400 font-mono text-right">Asks: {batchQueue?.asks ?? 0}</div>
        </div>
        <div className="flex gap-2">
          <input
            placeholder="Price"
            type="number"
            value={orderPrice}
            onChange={e => setOrderPrice(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono"
            disabled={!publicKey || orderBusy}
          />
          <input
            placeholder="Size (SOL)"
            type="number"
            value={orderSize}
            onChange={e => setOrderSize(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono"
            disabled={!publicKey || orderBusy}
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => placeOrder("Long")}
            disabled={!publicKey || orderBusy || !orderPrice || !orderSize}
            className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-40 rounded py-1 text-xs font-semibold"
          >
            Bid
          </button>
          <button
            onClick={() => placeOrder("Short")}
            disabled={!publicKey || orderBusy || !orderPrice || !orderSize}
            className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded py-1 text-xs font-semibold"
          >
            Ask
          </button>
        </div>
        <button
          onClick={cancelOrder}
          disabled={!publicKey || orderBusy}
          className="w-full text-xs text-slate-500 hover:text-slate-300 disabled:opacity-40"
        >
          Cancel My Order
        </button>
      </div>

      {/* Crank Status + Fee Income */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-slate-900 rounded p-2 text-xs">
          <div className="text-slate-500">Crank Batches</div>
          <div className="font-mono text-slate-300">{crankStatus?.batchesExecuted ?? 0}</div>
        </div>
        <div className="bg-slate-900 rounded p-2 text-xs">
          <div className="text-slate-500">Crank Fees</div>
          <div className="font-mono text-green-400">
            {((crankStatus?.batchesExecuted ?? 0) * 0.001).toFixed(3)} SOL
          </div>
        </div>
      </div>

      {/* Funding Rate History */}
      {fundingHistory.length > 0 && (
        <div className="text-xs space-y-1">
          <div className="text-slate-500 font-semibold">Funding History (8h)</div>
          {fundingHistory.slice(-8).map((f, i) => (
            <div key={i} className="flex justify-between font-mono">
              <span className="text-slate-500">{new Date(f.timestamp).toLocaleTimeString()}</span>
              <span className={f.rate >= 0 ? "text-green-400" : "text-red-400"}>
                {f.rate >= 0 ? "+" : ""}{f.rate.toFixed(4)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Optimistic confirmation banner */}
      {optimistic && !position?.isOpen ? (
        <div className="border border-indigo-500/50 rounded-lg p-4 animate-pulse">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
            <span className="text-sm text-indigo-300">Confirming on Solana...</span>
          </div>
          <div className="text-lg font-mono">
            {optimistic.side} ${optimistic.value.toFixed(2)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Transaction sent — waiting for block confirmation
          </div>
        </div>
      ) : /* Position View */
      position?.isOpen ? (
        <div className="space-y-2">
          <dl className="grid grid-cols-2 gap-1.5 text-xs">
            <dt className="text-slate-500">Side</dt>
            <dd className="text-right font-mono">{position.perpSide === 0 ? "Long" : "Short"}</dd>
            <dt className="text-slate-500">Size</dt>
            <dd className="text-right font-mono">{(Number(position.perpSize) / 1e9).toFixed(4)} SOL</dd>
            <dt className="text-slate-500">Entry</dt>
            <dd className="text-right font-mono">${(Number(position.entryPrice) / 1e6).toFixed(2)}</dd>
            <dt className="text-slate-500">Collateral</dt>
            <dd className="text-right font-mono">{(Number(position.collateralAmount) / 1e9).toFixed(4)} SOL</dd>
            <dt className="text-slate-500">Notional</dt>
            <dd className="text-right font-mono">${(Number(position.perpSize) / 1e6).toFixed(2)}</dd>
          </dl>
          <button
            onClick={onClose}
            disabled={busy}
            className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold"
          >
            {busy ? "Closing..." : "Close Position"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Trade Form */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Collateral (SOL)</label>
              <input
                type="number"
                value={collateral}
                onChange={e => setCollateral(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-sm"
                disabled={!publicKey}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Leverage</label>
              <input
                type="number"
                min={1}
                max={10}
                value={leverage}
                onChange={e => setLeverage(Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-sm"
                disabled={!publicKey}
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Notional: <span className="text-slate-300 font-mono">${notional.toFixed(2)}</span></span>
            <span>Clearing: <span className="text-slate-300 font-mono">${solPrice.toFixed(2)}</span> (Pyth)</span>
          </div>

          <div>
            <label className="block text-xs text-slate-500 mb-1">
              Jupiter Hedge: <span className="font-mono text-slate-300">{hedgePct}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={50}
              step={5}
              value={hedgePct}
              onChange={e => setHedgePct(Number(e.target.value))}
              className="w-full"
              disabled={!publicKey}
            />
            <div className="flex justify-between text-xs text-slate-600 mt-0.5">
              <span>No hedge</span><span>50%</span>
            </div>
          </div>

          {confirmDesc ? (
            <div className="border border-indigo-500/30 bg-indigo-950/30 rounded-lg p-4 space-y-3">
              <p className="text-xs text-slate-300 font-medium">Confirm Transaction</p>
              <p className="text-sm text-slate-200">{confirmDesc}</p>
              <div className="flex gap-2">
                <button
                  onClick={onOpen}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 rounded-lg py-2 text-sm font-semibold"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmDesc(null)}
                  className="flex-1 bg-slate-700 hover:bg-slate-600 rounded-lg py-2 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => requestOpen("Long")}
                disabled={!publicKey || busy || vaultRisk?.suspended}
                className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-40 rounded-lg py-2 text-sm font-bold"
              >
                {busy && side === "Long" ? "..." : "Long"}
              </button>
              <button
                onClick={() => requestOpen("Short")}
                disabled={!publicKey || busy || vaultRisk?.suspended}
                className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-lg py-2 text-sm font-bold"
              >
                {busy && side === "Short" ? "..." : "Short"}
              </button>
            </div>
          )}
        </div>
      )}

      {status && <p className="text-xs text-slate-400 text-center">{status}</p>}
    </div>
  );
};
