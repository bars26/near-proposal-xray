// Vote math, mirrored from sputnikdao2/src/policy.rs (`to_weight`, `proposal_status`,
// `can_execute_action`). A proposal passes as soon as ANY role that may VoteApprove
// on its kind reaches that role's threshold. "Everyone" roles are skipped by the
// contract when computing thresholds, so they can vote but never pass anything alone.

import type { Policy, ProposalKind, RolePermission, VotePolicy, WeightOrRatio } from "./types.ts";

export const KIND_LABELS = [
  "config",
  "policy",
  "add_member_to_role",
  "remove_member_from_role",
  "call",
  "upgrade_self",
  "upgrade_remote",
  "transfer",
  "set_vote_token",
  "add_bounty",
  "bounty_done",
  "vote",
  "factory_info_update",
  "policy_add_or_update_role",
  "policy_remove_role",
  "policy_update_default_vote_policy",
  "policy_update_parameters",
] as const;
export type KindLabel = (typeof KIND_LABELS)[number];

const LABEL_BY_VARIANT: Record<string, KindLabel> = {
  ChangeConfig: "config",
  ChangePolicy: "policy",
  AddMemberToRole: "add_member_to_role",
  RemoveMemberFromRole: "remove_member_from_role",
  FunctionCall: "call",
  UpgradeSelf: "upgrade_self",
  UpgradeRemote: "upgrade_remote",
  Transfer: "transfer",
  SetStakingContract: "set_vote_token",
  AddBounty: "add_bounty",
  BountyDone: "bounty_done",
  Vote: "vote",
  FactoryInfoUpdate: "factory_info_update",
  ChangePolicyAddOrUpdateRole: "policy_add_or_update_role",
  ChangePolicyRemoveRole: "policy_remove_role",
  ChangePolicyUpdateDefaultVotePolicy: "policy_update_default_vote_policy",
  ChangePolicyUpdateParameters: "policy_update_parameters",
};

export function variantOf(kind: ProposalKind): string {
  return typeof kind === "string" ? kind : Object.keys(kind)[0];
}

export function labelOf(kind: ProposalKind): KindLabel {
  return LABEL_BY_VARIANT[variantOf(kind)] ?? "call";
}

export function roleAllows(role: RolePermission, label: string, action: string): boolean {
  const p = role.permissions;
  return (
    p.includes(`${label}:${action}`) ||
    p.includes(`${label}:*`) ||
    p.includes(`*:${action}`) ||
    p.includes("*:*")
  );
}

/** sputnik `WeightOrRatio::to_weight`. */
export function toWeight(t: WeightOrRatio | undefined, total: bigint): bigint {
  if (t === undefined) return total;
  if (Array.isArray(t)) {
    const [num, den] = t;
    if (den === 0) return total;
    const w = (BigInt(num) * total) / BigInt(den) + 1n;
    return w < total ? w : total;
  }
  const w = BigInt(t);
  return w < total ? w : total;
}

export function votePolicyFor(policy: Policy, role: RolePermission, label: string): VotePolicy {
  return role.vote_policy?.[label] ?? policy.default_vote_policy;
}

export interface ApprovalPath {
  role: string;
  /** "group" roles are counted per member; "token" roles by staked token weight. */
  weighting: "group" | "token";
  /** For group roles: members of the role. */
  members: string[];
  /** For group roles: how many members must approve. For token roles: raw token weight needed (if known). */
  needed: bigint | null;
}

/** Every way a proposal of this kind can reach Approved under this policy. */
export function approvalPaths(policy: Policy, label: string): ApprovalPath[] {
  const out: ApprovalPath[] = [];
  for (const role of policy.roles) {
    if (!roleAllows(role, label, "VoteApprove")) continue;
    if (role.kind === "Everyone") continue; // skipped by proposal_status
    const vp = votePolicyFor(policy, role, label);
    const quorum = BigInt(vp.quorum ?? "0");
    if ("Group" in role.kind && vp.weight_kind !== "TokenWeight") {
      const members = role.kind.Group;
      const total = BigInt(members.length);
      const t = toWeight(vp.threshold, total);
      const needed = quorum > t ? quorum : t;
      out.push({ role: role.name, weighting: "group", members, needed });
    } else {
      out.push({
        role: role.name,
        weighting: "token",
        members: "Group" in role.kind ? role.kind.Group : [],
        needed: null,
      });
    }
  }
  return out;
}

/**
 * Smallest number of named accounts that can pass a proposal of this kind on their own,
 * or null when every path is token-weighted (or nobody can approve).
 */
export function minSigners(policy: Policy, label: string): { n: number; role: string } | null {
  let best: { n: number; role: string } | null = null;
  for (const p of approvalPaths(policy, label)) {
    if (p.weighting !== "group" || p.needed === null) continue;
    // A group of size 0 has threshold 0 but nobody to cast the vote.
    if (p.members.length === 0) continue;
    const n = Number(p.needed < 1n ? 1n : p.needed);
    if (n > p.members.length) continue;
    if (!best || n < best.n) best = { n, role: p.role };
  }
  return best;
}

/** Who may create a proposal of this kind. */
export function whoCanPropose(policy: Policy, label: string): { everyone: boolean; roles: string[] } {
  const roles = policy.roles.filter((r) => roleAllows(r, label, "AddProposal"));
  return { everyone: roles.some((r) => r.kind === "Everyone"), roles: roles.map((r) => r.name) };
}

export function membersOf(policy: Policy): Set<string> {
  const s = new Set<string>();
  for (const r of policy.roles) if (typeof r.kind === "object" && "Group" in r.kind) r.kind.Group.forEach((m) => s.add(m));
  return s;
}

/** Labels whose outcomes move money or control. Used to summarise a policy change. */
export const SENSITIVE_LABELS: KindLabel[] = [
  "transfer",
  "call",
  "policy",
  "upgrade_self",
  "add_member_to_role",
  "policy_add_or_update_role",
  "policy_update_default_vote_policy",
];

/** Applies a policy-changing proposal to a policy and returns the result (no mutation). */
export function applyPolicyChange(policy: Policy, kind: ProposalKind): Policy | null {
  if (typeof kind === "string") return null;
  const clone: Policy = JSON.parse(JSON.stringify(policy));
  if ("ChangePolicy" in kind) {
    const p = kind.ChangePolicy.policy as Policy;
    // Old "VersionedPolicy::Default(Vec<AccountId>)" form is a bare council list.
    if (Array.isArray(p)) return null;
    return p;
  }
  if ("AddMemberToRole" in kind) {
    const role = clone.roles.find((r) => r.name === kind.AddMemberToRole.role);
    if (role && typeof role.kind === "object" && "Group" in role.kind) {
      if (!role.kind.Group.includes(kind.AddMemberToRole.member_id)) role.kind.Group.push(kind.AddMemberToRole.member_id);
    }
    return clone;
  }
  if ("RemoveMemberFromRole" in kind) {
    const role = clone.roles.find((r) => r.name === kind.RemoveMemberFromRole.role);
    if (role && typeof role.kind === "object" && "Group" in role.kind) {
      role.kind.Group = role.kind.Group.filter((m) => m !== kind.RemoveMemberFromRole.member_id);
    }
    return clone;
  }
  if ("ChangePolicyAddOrUpdateRole" in kind) {
    const r = kind.ChangePolicyAddOrUpdateRole.role;
    const i = clone.roles.findIndex((x) => x.name === r.name);
    if (i >= 0) clone.roles[i] = r;
    else clone.roles.push(r);
    return clone;
  }
  if ("ChangePolicyRemoveRole" in kind) {
    clone.roles = clone.roles.filter((r) => r.name !== kind.ChangePolicyRemoveRole.role);
    return clone;
  }
  if ("ChangePolicyUpdateDefaultVotePolicy" in kind) {
    clone.default_vote_policy = kind.ChangePolicyUpdateDefaultVotePolicy.vote_policy;
    return clone;
  }
  if ("ChangePolicyUpdateParameters" in kind) {
    const p = kind.ChangePolicyUpdateParameters.parameters;
    if (p.proposal_bond) clone.proposal_bond = p.proposal_bond;
    if (p.proposal_period) clone.proposal_period = p.proposal_period;
    if (p.bounty_bond) clone.bounty_bond = p.bounty_bond;
    if (p.bounty_forgiveness_period) clone.bounty_forgiveness_period = p.bounty_forgiveness_period;
    return clone;
  }
  return null;
}

export interface PolicyDiffLine {
  label: KindLabel;
  before: { n: number; role: string } | null;
  after: { n: number; role: string } | null;
}

export interface PolicyDiff {
  lines: PolicyDiffLine[];
  addedMembers: string[];
  removedMembers: string[];
  periodBefore: bigint;
  periodAfter: bigint;
  roleChanges: string[];
}

export function diffPolicies(before: Policy, after: Policy): PolicyDiff {
  const lines = SENSITIVE_LABELS.map((label) => ({
    label,
    before: minSigners(before, label),
    after: minSigners(after, label),
  }));
  const b = membersOf(before);
  const a = membersOf(after);
  const roleChanges: string[] = [];
  const bRoles = new Map(before.roles.map((r) => [r.name, r]));
  const aRoles = new Map(after.roles.map((r) => [r.name, r]));
  for (const [name, r] of aRoles) {
    const old = bRoles.get(name);
    if (!old) roleChanges.push(`new role "${name}" with ${r.permissions.join(", ") || "no permissions"}`);
    else {
      const added = r.permissions.filter((p) => !old.permissions.includes(p));
      const removed = old.permissions.filter((p) => !r.permissions.includes(p));
      if (added.length) roleChanges.push(`role "${name}" gains ${added.join(", ")}`);
      if (removed.length) roleChanges.push(`role "${name}" loses ${removed.join(", ")}`);
    }
  }
  for (const name of bRoles.keys()) if (!aRoles.has(name)) roleChanges.push(`role "${name}" removed`);
  return {
    lines,
    addedMembers: [...a].filter((m) => !b.has(m)),
    removedMembers: [...b].filter((m) => !a.has(m)),
    periodBefore: BigInt(before.proposal_period),
    periodAfter: BigInt(after.proposal_period),
    roleChanges,
  };
}

export function isPolicyKind(kind: ProposalKind): boolean {
  const v = variantOf(kind);
  return (
    v === "ChangePolicy" ||
    v === "AddMemberToRole" ||
    v === "RemoveMemberFromRole" ||
    v.startsWith("ChangePolicy")
  );
}
