import { FC, useState } from "react";
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [vaultRisk, setVaultRisk] = useState<VaultRisk | null>(null);
  const [confirmDesc, setConfirmDesc] = useState<string | null>(null);
  const [pendingSide, setPendingSide] = useState<"Long" | "Short">("Long");
  const [optimistic, setOptimistic] = useState<{ side: string; value: number } | null>(null);

  // Fetch vault risk on mount
  useState(() => {
    fetch(`${API_BASE}/vault/risk`)
      .then(r => r.json())
      .then(setVaultRisk)
      .catch(() => {});
  });

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
      const sig = await sendTx("/build-tx/open", {
        wallet: publicKey.toBase58(),
        collateralAmount: lamports.toString(),
        borrowAmount: borrow.toString(),
        side,
        leverageBps: leverage * 1000,
        hedgeAmount: "0",
        useKamino: true,
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
      const sig = await sendTx("/build-tx/close", { wallet: publicKey.toBase58(), useKamino: true });
      setStatus(`Closed: ${sig.slice(0, 8)}...`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-slate-800 rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Pro Trading</span>
        <span className="text-xs text-slate-500">SOL-PERP</span>
      </div>

      {/* Vault & Funding Info */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-slate-900 rounded p-2">
          <div className="text-slate-500">Spread</div>
          <div className="font-mono text-slate-300">
            {vaultRisk?.suspended ? (
              <span className="text-red-400">SUSPENDED</span>
            ) : (
              `${vaultRisk?.spreadBps ?? "—"} bps`
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
