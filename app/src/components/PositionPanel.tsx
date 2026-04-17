import { FC, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { PositionView } from "../hooks/usePosition";
import { useCollateralTypes } from "../hooks/useCollateralTypes";
import { API_BASE } from "../config";
import { describeTransaction } from "../lib/tx-description";

export const PositionPanel: FC<{
  position: PositionView | null;
  solPrice: number;
  onConfirming?: () => void;
  onConfirmed?: () => void;
}> = ({ position, solPrice, onConfirming, onConfirmed }) => {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [collateral, setCollateral] = useState("0.1");
  const [leverage, setLeverage] = useState(3);
  const [side, setSide] = useState<"Long" | "Short">("Long");
  const [market, setMarket] = useState("SOL-PERP");
  const [useHedge, setUseHedge] = useState(false);
  const [collateralType, setCollateralType] = useState("SOL");
  const collateralTypes = useCollateralTypes();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<{ side: string; value: number } | null>(null);
  const [confirmDesc, setConfirmDesc] = useState<string | null>(null);

  const notional = Number(collateral) * solPrice * leverage;

  const sendBuiltTx = async (endpoint: string, body: any) => {
    if (!publicKey || !signTransaction) throw new Error("wallet not connected");
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "build failed");
    const { tx: b64 } = await res.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  };

  const requestOpen = () => {
    const desc = describeTransaction({
      type: "open",
      side,
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
    try {
      // Optimistic: show immediately
      setOptimistic({ side, value: Number(collateral) * solPrice * leverage });
      onConfirming?.();

      const collateralLamports = BigInt(Math.floor(Number(collateral) * 1e9));
      const borrowUsdc = BigInt(Math.floor(Number(collateral) * solPrice * (leverage - 1) * 1e6));
      const hedgeAmount = useHedge ? BigInt(Math.floor(Number(borrowUsdc) * 25 / 100)) : 0n;
      const sig = await sendBuiltTx("/build-tx/open", {
        wallet: publicKey.toBase58(),
        collateralAmount: collateralLamports.toString(),
        borrowAmount: borrowUsdc.toString(),
        side,
        leverageBps: leverage * 1000,
        hedgeAmount: hedgeAmount.toString(),
        useKamino: true,
        market,
      });
      setStatus(`Opened: ${sig.slice(0, 8)}…`);
      setOptimistic(null);
      onConfirmed?.();
    } catch (e: any) {
      setStatus(`Error: ${e.message ?? e}`);
      setOptimistic(null);
      onConfirmed?.();
    } finally {
      setBusy(false);
    }
  };

  const onClose = async () => {
    if (!publicKey) return;
    setBusy(true);
    setStatus(null);
    try {
      const sig = await sendBuiltTx("/build-tx/close", {
        wallet: publicKey.toBase58(),
        useKamino: true,
      });
      setStatus(`Closed: ${sig.slice(0, 8)}…`);
    } catch (e: any) {
      setStatus(`Error: ${e.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  // Optimistic confirmation banner
  if (optimistic && !position?.isOpen) {
    return (
      <div className="border border-indigo-500/50 rounded-xl p-4 animate-pulse">
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
    );
  }

  if (position?.isOpen) {
    return (
      <div className="border border-slate-800 rounded-xl p-4">
        <div className="text-sm text-slate-400 mb-2">Open position</div>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-slate-400">Side</dt>
          <dd className="text-right font-mono">
            {position.perpSide === 0 ? "Long" : "Short"}
          </dd>
          <dt className="text-slate-400">Size</dt>
          <dd className="text-right font-mono">
            {(Number(position.perpSize) / 1e9).toFixed(4)} SOL
          </dd>
          <dt className="text-slate-400">Entry</dt>
          <dd className="text-right font-mono">
            ${(Number(position.entryPrice) / 1e6).toFixed(2)}
          </dd>
          <dt className="text-slate-400">Collateral</dt>
          <dd className="text-right font-mono">
            {(Number(position.collateralAmount) / 1e9).toFixed(4)} SOL
          </dd>
        </dl>
        <button
          onClick={onClose}
          disabled={busy}
          className="w-full mt-4 bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold"
        >
          {busy ? "Closing…" : "Close position"}
        </button>
        {status && <div className="mt-2 text-xs text-slate-400">{status}</div>}
      </div>
    );
  }

  return (
    <div className="border border-slate-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-400">Open position</span>
        <div className="flex gap-1">
          {["SOL-PERP", "BTC-PERP", "ETH-PERP"].map(m => (
            <button
              key={m}
              onClick={() => setMarket(m)}
              className={`px-2 py-0.5 text-xs rounded ${
                market === m ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400"
              }`}
            >
              {m.split("-")[0]}
            </button>
          ))}
        </div>
      </div>

      <label className="block text-xs text-slate-500">Collateral (SOL)</label>
      <input
        type="number"
        value={collateral}
        onChange={(e) => setCollateral(e.target.value)}
        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 font-mono"
        disabled={!publicKey}
      />

      <label className="block text-xs text-slate-500">
        Leverage: <span className="font-mono">{leverage}x</span>
      </label>
      <input
        type="range"
        min={1}
        max={10}
        value={leverage}
        onChange={(e) => setLeverage(Number(e.target.value))}
        className="w-full"
        disabled={!publicKey}
      />

      <div className="flex gap-2">
        <button
          onClick={() => setSide("Long")}
          className={`flex-1 rounded-lg py-2 text-sm font-semibold ${
            side === "Long" ? "bg-green-600" : "bg-slate-800"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setSide("Short")}
          className={`flex-1 rounded-lg py-2 text-sm font-semibold ${
            side === "Short" ? "bg-red-600" : "bg-slate-800"
          }`}
        >
          Short
        </button>
      </div>

      {/* Collateral type selector */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">Collateral</span>
        <select
          value={collateralType}
          onChange={(e) => setCollateralType(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
        >
          {collateralTypes.filter(c => c.enabled).map(c => (
            <option key={c.type} value={c.type}>{c.label} ({c.haircutPct}% haircut)</option>
          ))}
        </select>
      </div>

      {/* Hedge toggle */}
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
        <input
          type="checkbox"
          checked={useHedge}
          onChange={(e) => setUseHedge(e.target.checked)}
          className="rounded"
          disabled={!publicKey}
        />
        Spot hedge (25% via Jupiter)
      </label>

      <div className="text-xs text-slate-500">
        Notional: <span className="font-mono text-slate-300">${notional.toFixed(2)}</span>
        {useHedge && <span className="ml-2 text-indigo-400">+ 25% hedged</span>}
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
        <button
          onClick={requestOpen}
          disabled={!publicKey || busy}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 rounded-lg py-2 text-sm font-semibold"
        >
          {!publicKey ? "Connect wallet" : busy ? "Opening…" : "Open atomic position"}
        </button>
      )}
      {status && <div className="text-xs text-slate-400">{status}</div>}
    </div>
  );
};
