import { FC, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { PositionView } from "../hooks/usePosition";
import { API_BASE } from "../config";
import { describeTransaction } from "../lib/tx-description";

const MARKETS = [
  { symbol: "SOL-PERP", label: "SOL", priceKey: "sol" },
  { symbol: "BTC-PERP", label: "BTC", priceKey: "btc" },
  { symbol: "ETH-PERP", label: "ETH", priceKey: "eth" },
];

const FEED_TO_MARKET: Record<string, string> = {
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": "SOL-PERP",
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": "BTC-PERP",
  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": "ETH-PERP",
};

export const SimplePanel: FC<{
  positions: PositionView[];
  prices: Record<string, number>;
  solPrice: number;
}> = ({ positions, prices, solPrice }) => {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("0.1");
  const [leverage, setLeverage] = useState(2);
  const [market, setMarket] = useState("SOL-PERP");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ side: "Long" | "Short"; desc: string } | null>(null);
  const [optimistic, setOptimistic] = useState<{ side: string; value: number } | null>(null);

  const marketInfo = MARKETS.find(m => m.symbol === market) || MARKETS[0];
  const markPrice = prices[marketInfo.priceKey] || solPrice;
  // Collateral is SOL, so value = SOL amount * SOL price * leverage
  const collateralValue = Number(amount) * solPrice;
  const estValue = collateralValue * leverage;

  // Find position for current market
  const positionForMarket = positions.find(p => FEED_TO_MARKET[p.perpMarket] === market);

  const sendTx = async (endpoint: string, body: any) => {
    if (!publicKey || !signTransaction) throw new Error("Connect wallet first");
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message ?? err.error ?? "Transaction failed");
    }
    const data = await res.json();
    const b64List: string[] = data.txs ?? [data.tx];
    const txList = b64List.map((b64: string) =>
      VersionedTransaction.deserialize(Buffer.from(b64, "base64"))
    );
    let signedList: VersionedTransaction[];
    if (signAllTransactions && txList.length > 1) {
      signedList = await signAllTransactions(txList);
    } else {
      signedList = [await signTransaction(txList[0])];
    }
    let sig = "";
    for (const signed of signedList) {
      sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");
    }
    return sig;
  };

  const requestOpen = (side: "Long" | "Short") => {
    const desc = describeTransaction({
      type: "open",
      side,
      collateralSol: Number(amount),
      leverage,
      solPrice,
    });
    setConfirm({ side, desc });
  };

  const executeOpen = async () => {
    if (!publicKey || !confirm) return;
    const { side } = confirm;
    setConfirm(null);
    setBusy(true);
    setStatus(null);
    setOptimistic({ side, value: estValue });
    try {
      const lamports = BigInt(Math.floor(Number(amount) * 1e9));
      await sendTx("/build-tx/open", {
        wallet: publicKey.toBase58(),
        collateralAmount: lamports.toString(),
        side,
        leverageBps: leverage * 1000,
        hedgeAmount: "0",
        useKamino: false,
        collateralType: "SOL",
        market,
      });
      setStatus("Position opened");
      setOptimistic(null);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
      setOptimistic(null);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!publicKey) return;
    setBusy(true);
    setStatus(null);
    try {
      await sendTx("/build-tx/close", { wallet: publicKey.toBase58(), useKamino: false, market });
      setStatus("Position closed");
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  // Optimistic confirmation banner
  if (optimistic && !positionForMarket?.isOpen) {
    return (
      <div className="border border-indigo-500/50 rounded-xl p-5 animate-pulse">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
          <span className="text-sm text-indigo-300">Confirming on Solana...</span>
        </div>
        <div className="text-2xl font-mono font-bold">
          ${optimistic.value.toFixed(2)}
          <span className="text-sm text-slate-500 ml-2">{optimistic.side} {marketInfo.label}</span>
        </div>
        <div className="text-xs text-slate-500 mt-1">
          Transaction sent — waiting for block confirmation
        </div>
      </div>
    );
  }

  // Open position view for this market
  if (positionForMarket?.isOpen) {
    const pos = positionForMarket;
    const entryPrice = Number(pos.entryPrice) / 1e6;
    const pnlRaw = (markPrice - entryPrice) *
      (Number(pos.perpSize) / 1e6 / markPrice) *
      (pos.perpSide === 0 ? 1 : -1);
    const collValue = Number(pos.collateralAmount) / 1e9 * solPrice;
    const pnlPct = collValue > 0 ? (pnlRaw / collValue) * 100 : 0;

    return (
      <div className="border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Your {marketInfo.label} Position</span>
            <div className="flex gap-1">
              {MARKETS.map(m => (
                <button
                  key={m.symbol}
                  onClick={() => setMarket(m.symbol)}
                  className={`px-2 py-0.5 text-xs rounded-md ${
                    market === m.symbol
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                  }`}
                >{m.label}</button>
              ))}
            </div>
          </div>
          <span className={`text-sm font-mono ${pnlRaw >= 0 ? "text-green-400" : "text-red-400"}`}>
            {pnlRaw >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
          </span>
        </div>

        <div className="text-2xl font-mono font-bold">
          ${collValue.toFixed(2)}
          <span className="text-sm text-slate-500 ml-2">
            {pos.perpSide === 0 ? "Long" : "Short"} {marketInfo.label}
          </span>
        </div>

        <button
          onClick={close}
          disabled={busy}
          className="w-full bg-slate-700 hover:bg-slate-600 disabled:opacity-40 rounded-lg py-2.5 text-sm font-semibold"
        >
          {busy ? "Closing..." : "Close Position"}
        </button>
        {status && <p className="text-xs text-slate-400 text-center">{status}</p>}
      </div>
    );
  }

  return (
    <div className="border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-400">Start Trading</span>
        <div className="flex gap-1">
          {MARKETS.map(m => {
            const hasPosition = positions.some(p => FEED_TO_MARKET[p.perpMarket] === m.symbol && p.isOpen);
            return (
              <button
                key={m.symbol}
                onClick={() => setMarket(m.symbol)}
                className={`px-2.5 py-1 text-xs rounded-md font-medium ${
                  market === m.symbol
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                }`}
              >
                {m.label}
                {hasPosition && <span className="ml-1 text-green-400">*</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="text-xs text-slate-500 text-center">
        {marketInfo.label} Price: <span className="font-mono text-white">
          ${markPrice < 100 ? markPrice.toFixed(2) : markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </span>
      </div>

      <div>
        <label className="block text-xs text-slate-500 mb-1">Amount (SOL)</label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 font-mono text-lg"
          placeholder="0.1"
          disabled={!publicKey}
        />
      </div>

      <div>
        <label className="block text-xs text-slate-500 mb-1">
          Multiplier: <span className="font-mono text-white">{leverage}x</span>
        </label>
        <input
          type="range"
          min={1}
          max={5}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className="w-full"
          disabled={!publicKey}
        />
        <div className="flex justify-between text-xs text-slate-600 mt-0.5">
          <span>1x</span><span>5x</span>
        </div>
      </div>

      <div className="text-center text-sm text-slate-400">
        Position value: <span className="font-mono text-white">${estValue.toFixed(2)}</span>
      </div>

      {confirm ? (
        <div className="border border-indigo-500/30 bg-indigo-950/30 rounded-lg p-4 space-y-3">
          <p className="text-xs text-slate-300 font-medium">Confirm Transaction</p>
          <p className="text-sm text-slate-200">{confirm.desc}</p>
          <div className="flex gap-2">
            <button
              onClick={executeOpen}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 rounded-lg py-2 text-sm font-semibold"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirm(null)}
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
            disabled={!publicKey || busy}
            className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-40 rounded-lg py-2.5 text-sm font-bold"
          >
            {busy ? "..." : `Long ${marketInfo.label}`}
          </button>
          <button
            onClick={() => requestOpen("Short")}
            disabled={!publicKey || busy}
            className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-lg py-2.5 text-sm font-bold"
          >
            {busy ? "..." : `Short ${marketInfo.label}`}
          </button>
        </div>
      )}

      {!publicKey && (
        <p className="text-xs text-slate-500 text-center">Connect wallet to start</p>
      )}
      {status && <p className="text-xs text-slate-400 text-center">{status}</p>}
    </div>
  );
};
