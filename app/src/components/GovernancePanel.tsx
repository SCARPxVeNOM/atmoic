import { FC, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { API_BASE } from "../config";

interface Proposal {
  id: string;
  type: string;
  title: string;
  description: string;
  proposer: string;
  votesFor: string;
  votesAgainst: string;
  expiresAt: number;
  passed: boolean | null;
}

export const GovernancePanel: FC = () => {
  const { publicKey } = useWallet();
  const [proposals, setProposals] = useState<Proposal[]>([]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/governance/proposals`);
        if (r.ok && alive) setProposals(await r.json());
      } catch { /* endpoint not available yet */ }
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const vote = async (proposalId: string, support: boolean) => {
    if (!publicKey) return;
    try {
      await fetch(`${API_BASE}/governance/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId, voter: publicKey.toBase58(), support }),
      });
    } catch { /* ignore */ }
  };

  if (proposals.length === 0) {
    return (
      <div className="border border-slate-800 rounded-xl p-4 text-center text-sm text-slate-500">
        No active governance proposals
      </div>
    );
  }

  return (
    <div className="border border-slate-800 rounded-xl p-4 space-y-3">
      <div className="text-sm font-semibold">Governance</div>

      {proposals.map(p => {
        const expired = Date.now() > p.expiresAt;
        const total = BigInt(p.votesFor) + BigInt(p.votesAgainst);
        const forPct = total > 0n ? Number((BigInt(p.votesFor) * 100n) / total) : 0;

        return (
          <div key={p.id} className="bg-slate-900 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{p.title}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                p.passed === true ? "bg-green-900 text-green-300" :
                p.passed === false ? "bg-red-900 text-red-300" :
                "bg-slate-800 text-slate-400"
              }`}>
                {p.passed === true ? "Passed" : p.passed === false ? "Failed" : expired ? "Expired" : "Active"}
              </span>
            </div>

            <p className="text-xs text-slate-500">{p.description}</p>

            {/* Vote bar */}
            <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full"
                style={{ width: `${forPct}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-slate-600">
              <span>For: {forPct}%</span>
              <span>Against: {100 - forPct}%</span>
            </div>

            {!expired && p.passed === null && publicKey && (
              <div className="flex gap-2">
                <button
                  onClick={() => vote(p.id, true)}
                  className="flex-1 bg-green-800 hover:bg-green-700 rounded py-1 text-xs"
                >
                  Vote For
                </button>
                <button
                  onClick={() => vote(p.id, false)}
                  className="flex-1 bg-red-800 hover:bg-red-700 rounded py-1 text-xs"
                >
                  Vote Against
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
