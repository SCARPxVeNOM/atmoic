/**
 * Governance System — community parameter voting.
 *
 * Per composable-perps-docs section 15:
 * - Proposal types: new market, collateral, fee change, emergency pause
 * - Token-weighted voting, 3-day window, 10% quorum
 * - Auto-execution via Squads on passing vote
 */

export type ProposalType = "new_market" | "collateral_type" | "fee_change" | "emergency_pause" | "tvl_cap";

export interface Proposal {
  id: string;
  type: ProposalType;
  title: string;
  description: string;
  proposer: string;          // wallet
  params: Record<string, any>;
  votesFor: bigint;
  votesAgainst: bigint;
  quorumRequired: bigint;    // 10% of total supply
  createdAt: number;
  expiresAt: number;
  executed: boolean;
  passed: boolean | null;    // null = pending
}

export interface Vote {
  voter: string;
  proposalId: string;
  weight: bigint;
  support: boolean;
  timestamp: number;
}

const VOTING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const proposals: Map<string, Proposal> = new Map();
const votes: Map<string, Vote[]> = new Map(); // proposalId -> votes

let proposalCounter = 0;

/** Create a new governance proposal. */
export function createProposal(
  type: ProposalType,
  title: string,
  description: string,
  proposer: string,
  params: Record<string, any>,
  totalSupply: bigint,
): Proposal {
  const id = `prop-${++proposalCounter}`;
  const now = Date.now();
  const proposal: Proposal = {
    id,
    type,
    title,
    description,
    proposer,
    params,
    votesFor: 0n,
    votesAgainst: 0n,
    quorumRequired: totalSupply / 10n, // 10% quorum
    createdAt: now,
    expiresAt: now + VOTING_WINDOW_MS,
    executed: false,
    passed: null,
  };
  proposals.set(id, proposal);
  votes.set(id, []);
  return proposal;
}

/** Cast a vote on a proposal. */
export function castVote(
  proposalId: string,
  voter: string,
  weight: bigint,
  support: boolean,
): boolean {
  const proposal = proposals.get(proposalId);
  if (!proposal || Date.now() > proposal.expiresAt) return false;

  const existing = (votes.get(proposalId) ?? []).find(v => v.voter === voter);
  if (existing) return false; // Already voted

  const vote: Vote = { voter, proposalId, weight, support, timestamp: Date.now() };
  votes.get(proposalId)!.push(vote);

  if (support) proposal.votesFor += weight;
  else proposal.votesAgainst += weight;

  return true;
}

/** Finalize a proposal (call after voting window). */
export function finalizeProposal(proposalId: string): Proposal | null {
  const proposal = proposals.get(proposalId);
  if (!proposal || proposal.passed !== null) return proposal ?? null;

  const totalVotes = proposal.votesFor + proposal.votesAgainst;
  const quorumMet = totalVotes >= proposal.quorumRequired;
  const majorityFor = proposal.votesFor > proposal.votesAgainst;

  proposal.passed = quorumMet && majorityFor;
  return proposal;
}

export function getProposal(id: string): Proposal | undefined {
  return proposals.get(id);
}

export function listProposals(activeOnly = false): Proposal[] {
  const all = [...proposals.values()];
  if (activeOnly) return all.filter(p => p.passed === null && Date.now() <= p.expiresAt);
  return all;
}
