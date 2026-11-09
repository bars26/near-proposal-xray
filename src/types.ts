// Sputnik DAO v2 shapes, as returned by the contract's view methods.
// Source of truth: https://github.com/near-daos/sputnik-dao-contract (sputnikdao2).

export type U128 = string;

export type WeightOrRatio = U128 | [number, number];

export interface VotePolicy {
  weight_kind?: "TokenWeight" | "RoleWeight";
  quorum?: U128;
  threshold?: WeightOrRatio;
}

export type RoleKind =
  | "Everyone"
  | { Member: U128 }
  | { Group: string[] };

export interface RolePermission {
  name: string;
  kind: RoleKind;
  permissions: string[];
  vote_policy: Record<string, VotePolicy>;
}

export interface Policy {
  roles: RolePermission[];
  default_vote_policy: VotePolicy;
  proposal_bond: U128;
  proposal_period: U128;
  bounty_bond: U128;
  bounty_forgiveness_period: U128;
}

export interface ActionCall {
  method_name: string;
  args: string; // base64
  deposit: U128;
  gas: U128 | number;
}

export interface Bounty {
  description: string;
  token: string;
  amount: U128;
  times: number;
  max_deadline: U128;
}

export interface PolicyParameters {
  proposal_bond?: U128 | null;
  proposal_period?: U128 | null;
  bounty_bond?: U128 | null;
  bounty_forgiveness_period?: U128 | null;
}

export type ProposalKind =
  | { ChangeConfig: { config: { name: string; purpose: string; metadata: string } } }
  | { ChangePolicy: { policy: Policy | Record<string, unknown> } }
  | { AddMemberToRole: { member_id: string; role: string } }
  | { RemoveMemberFromRole: { member_id: string; role: string } }
  | { FunctionCall: { receiver_id: string; actions: ActionCall[] } }
  | { UpgradeSelf: { hash: string } }
  | { UpgradeRemote: { receiver_id: string; method_name: string; hash: string } }
  | { Transfer: { token_id: string; receiver_id: string; amount: U128; msg?: string | null } }
  | { SetStakingContract: { staking_id: string } }
  | { AddBounty: { bounty: Bounty } }
  | { BountyDone: { bounty_id: number; receiver_id: string } }
  | "Vote"
  | { FactoryInfoUpdate: { factory_info: unknown } }
  | { ChangePolicyAddOrUpdateRole: { role: RolePermission } }
  | { ChangePolicyRemoveRole: { role: string } }
  | { ChangePolicyUpdateDefaultVotePolicy: { vote_policy: VotePolicy } }
  | { ChangePolicyUpdateParameters: { parameters: PolicyParameters } };

export type ProposalStatus =
  | "InProgress"
  | "Approved"
  | "Rejected"
  | "Removed"
  | "Expired"
  | "Moved"
  | "Failed";

export interface Proposal {
  id: number;
  proposer: string;
  description: string;
  kind: ProposalKind;
  status: ProposalStatus;
  vote_counts: Record<string, [U128 | number, U128 | number, U128 | number]>;
  votes: Record<string, "Approve" | "Reject" | "Remove">;
  submission_time: U128;
}

/** Everything the analyser needs about the DAO itself, fetched once per DAO. */
export interface DaoContext {
  daoId: string;
  policy: Policy;
  /** Liquid NEAR held by the DAO account, in yocto. */
  nearBalance: bigint;
  /** Code hashes the Sputnik factory knows about (safe upgrade targets). */
  knownCodeHashes: string[];
  /** hash -> "v3.2" etc., from the factory's contract metadata. */
  versions?: Record<string, string>;
  /** Code currently deployed on the DAO account. */
  codeHash?: string;
}

/** On-chain facts about accounts and tokens a proposal touches. */
export interface ChainFacts {
  /** account id -> exists on chain? */
  accountExists: Record<string, boolean>;
  /** account id -> has contract code deployed? */
  hasCode: Record<string, boolean>;
  /** token contract -> metadata */
  tokens: Record<string, { symbol: string; decimals: number } | null>;
  /** token contract -> DAO's balance of it (raw units) */
  daoTokenBalance: Record<string, bigint | null>;
  /** intents token id (nep141:…) -> DAO's balance inside NEAR Intents */
  intentsBalance?: Record<string, bigint | null>;
}
