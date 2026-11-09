// DAO-level health: how hard is it to move money or change the rules here?

import { approvalPaths, membersOf, minSigners, roleAllows } from "./policy.ts";
import type { Severity } from "./analyze.ts";
import type { DaoContext } from "./types.ts";

export interface DaoHealth {
  members: number;
  version: string | null;
  codeKnown: boolean | null;
  signers: { label: string; text: string; n: number | null }[];
  notes: { severity: Severity; text: string }[];
}

const SHOWN: [string, string][] = [
  ["transfer", "Send funds"],
  ["call", "Call any contract"],
  ["policy", "Rewrite the rules"],
  ["add_member_to_role", "Add members"],
  ["upgrade_self", "Replace DAO code"],
];

export function daoHealth(ctx: DaoContext): DaoHealth {
  const p = ctx.policy;
  const notes: DaoHealth["notes"] = [];
  const signers = SHOWN.map(([label, text]) => {
    const m = minSigners(p, label);
    const tokenOnly = !m && approvalPaths(p, label).some((x) => x.weighting === "token");
    return { label, text: tokenOnly ? `${text} (token vote)` : text, n: m?.n ?? null };
  });
  const money = signers.find((s) => s.label === "call")!;
  if (money.n === 1) notes.push({ severity: "critical", text: "A single account can pass FunctionCall proposals, i.e. move any asset, alone." });
  const t = signers.find((s) => s.label === "transfer")!;
  if (t.n === 1 && money.n !== 1) notes.push({ severity: "high", text: "A single account can approve transfers alone." });

  const members = membersOf(p).size;
  if (members === 1) notes.push({ severity: "high", text: "The DAO has one member: it is a multisig of one." });

  const proposeEveryone = p.roles.some((r) => r.kind === "Everyone" && roleAllows(r, "call", "AddProposal"));
  if (proposeEveryone) notes.push({ severity: "info", text: "Anyone on NEAR can submit proposals here, so spam and look-alike proposals are possible." });

  const periodH = Number(BigInt(p.proposal_period) / 3_600_000_000_000n);
  if (periodH < 24) notes.push({ severity: "medium", text: `Proposals expire after ${periodH} h: little time for members to review.` });

  let codeKnown: boolean | null = null;
  let version: string | null = null;
  if (ctx.codeHash && ctx.knownCodeHashes.length) {
    codeKnown = ctx.knownCodeHashes.includes(ctx.codeHash);
    version = ctx.versions?.[ctx.codeHash] ?? null;
    if (!codeKnown) notes.push({ severity: "high", text: `The DAO runs code (${ctx.codeHash.slice(0, 10)}…) that the Sputnik factory never published.` });
  }
  return { members, version, codeKnown, signers, notes };
}
