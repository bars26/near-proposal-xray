import type { ChainFacts, DaoContext, Policy, Proposal, ProposalKind } from "../src/types.ts";

export const DAO = "acme.sputnik-dao.near";
export const NOW = Date.UTC(2026, 10, 9);
export const NEAR = 10n ** 24n;

export function b64(obj: unknown): string {
  return Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)).toString("base64");
}

export function policy(council: string[], threshold: [number, number] = [1, 2], extra: Partial<Policy> = {}): Policy {
  return {
    roles: [
      {
        name: "Council",
        kind: { Group: council },
        permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
        vote_policy: {},
      },
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold },
    proposal_bond: (NEAR / 10n).toString(),
    proposal_period: "604800000000000",
    bounty_bond: (NEAR / 10n).toString(),
    bounty_forgiveness_period: "604800000000000",
    ...extra,
  };
}

export function ctx(p: Policy = policy(["alice.near", "bob.near", "carol.near"]), nearBalance = 1000n * NEAR): DaoContext {
  return {
    daoId: DAO,
    policy: p,
    nearBalance,
    knownCodeHashes: ["DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF", "2Zof1Tyy4pMeJM48mDSi5ww2QQhTz97b9S8h6W6r4HnK"],
  };
}

export function facts(over: Partial<ChainFacts> = {}): ChainFacts {
  return {
    accountExists: {},
    hasCode: {},
    tokens: { "usdt.tether-token.near": { symbol: "USDt", decimals: 6 } },
    daoTokenBalance: { "usdt.tether-token.near": 10_000n * 10n ** 6n },
    ...over,
  };
}

export function proposal(kind: ProposalKind, over: Partial<Proposal> = {}): Proposal {
  return {
    id: 7,
    proposer: "alice.near",
    description: "",
    kind,
    status: "InProgress",
    vote_counts: {},
    votes: {},
    submission_time: (BigInt(NOW - 86_400_000) * 1_000_000n).toString(),
    ...over,
  };
}

export function call(receiver_id: string, ...actions: { method: string; args?: unknown; deposit?: bigint }[]): ProposalKind {
  return {
    FunctionCall: {
      receiver_id,
      actions: actions.map((a) => ({
        method_name: a.method,
        args: a.args === undefined ? "" : b64(a.args),
        deposit: (a.deposit ?? 0n).toString(),
        gas: "150000000000000",
      })),
    },
  };
}
