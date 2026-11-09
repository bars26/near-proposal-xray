// The X-Ray: decodes a proposal and runs every risk rule against it.
// Rules only fire on facts we actually have; missing chain data never raises a flag.

import {
  applyPolicyChange,
  approvalPaths,
  diffPolicies,
  isPolicyKind,
  labelOf,
  membersOf,
  minSigners,
  roleAllows,
  type PolicyDiff,
} from "./policy.ts";
import {
  assetKey,
  decodeProposal,
  describeAccount,
  ftContractOf,
  mentionedAmounts,
  parseDescription,
  type Decoded,
  type Effect,
} from "./decode.ts";
import { isImplicit, isNearAccountId } from "./chain.ts";
import { assetInfo, durationNs, formatAmount, formatUnits, toNumber } from "./format.ts";
import type { ChainFacts, DaoContext, Proposal } from "./types.ts";

export type Severity = "critical" | "high" | "medium" | "info";
export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "info"];

export interface Flag {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface VoteState {
  label: string;
  /** Every role that can pass this proposal, with progress. */
  paths: { role: string; weighting: "group" | "token"; approvals: number; needed: number | null; members: number }[];
  /** Fewest additional approvals that would pass it (group roles only). */
  remaining: number | null;
  expiresAtMs: number;
  expired: boolean;
}

export interface Report {
  daoId: string;
  id: number;
  proposer: string;
  status: string;
  submittedAtMs: number;
  description: ParsedDescriptionOut;
  decoded: Decoded;
  summary: string[];
  flags: Flag[];
  votes: VoteState;
  policyDiff: PolicyDiff | null;
  worst: Severity | null;
  /**
   * Checks that could not run (unknown method, chain data missing, release list
   * unavailable). A report with no flags but a non-empty list is "partly checked", not clean.
   */
  unchecked: string[];
}

interface ParsedDescriptionOut {
  raw: string;
  title: string;
  claimedAction: string | null;
  fields: Record<string, string>;
}

const PCT_CRITICAL = 0.5;
const PCT_HIGH = 0.2;

export function analyze(p: Proposal, ctx: DaoContext, facts: ChainFacts, nowMs = Date.now()): Report {
  const decoded = decodeProposal(ctx.daoId, p);
  const desc = parseDescription(p.description ?? "");
  const flags: Flag[] = [];
  const unchecked: string[] = [];
  const add =(id: string, severity: Severity, title: string, detail: string) => flags.push({ id, severity, title, detail });
  const members = membersOf(ctx.policy);
  const label = labelOf(p.kind);
  const k = p.kind as any;
  const approvers = new Set(approvalPaths(ctx.policy, label).flatMap((a) => a.members));

  // ---- outflows vs treasury ----
  const outflows = decoded.effects.filter((e): e is Extract<Effect, { type: "outflow" }> => e.type === "outflow");
  const totals = new Map<string, { asset: Effect & { type: "outflow" }; amount: bigint }>();
  for (const o of outflows) {
    const key = assetKey(o.asset);
    const t = totals.get(key);
    if (t) t.amount += o.amount;
    else totals.set(key, { asset: o, amount: o.amount });
  }
  // Balances are today's; comparing them to finished proposals says nothing.
  // Expired proposals keep status InProgress on chain until someone finalizes them.
  const votes = voteState(p, ctx, nowMs);
  const live = p.status === "InProgress" && !votes.expired;
  for (const { asset: o, amount } of live ? totals.values() : []) {
    let balance: bigint | null = null;
    if (o.asset.kind === "near") balance = ctx.nearBalance;
    else if (o.asset.kind === "ft") balance = facts.daoTokenBalance[o.asset.contract] ?? null;
    else if (o.asset.kind === "intents") balance = facts.intentsBalance?.[o.asset.tokenId] ?? null;
    if (amount === 0n) continue;
    if (balance === null) {
      if (o.asset.kind !== "nft") unchecked.push(`DAO balance of ${assetInfo(o.asset, facts).symbol} unknown: treasury share not checked.`);
      continue;
    }
    const pretty = formatAmount(amount, o.asset, facts);
    if (amount > balance) {
      add(
        "exceeds-balance",
        "medium",
        `Asks for more than the DAO holds`,
        `${pretty} requested; the DAO holds ${formatAmount(balance, o.asset, facts)}. It will fail on execution unless funds arrive first.`,
      );
      continue;
    }
    const share = Number((amount * 10000n) / (balance === 0n ? 1n : balance)) / 10000;
    if (share >= PCT_CRITICAL) {
      add("treasury-share", "critical", `Moves ${Math.round(share * 100)}% of the DAO's ${assetInfo(o.asset, facts).symbol}`, `${pretty} out of ${formatAmount(balance, o.asset, facts)} held.`);
    } else if (share >= PCT_HIGH) {
      add("treasury-share", "high", `Moves ${Math.round(share * 100)}% of the DAO's ${assetInfo(o.asset, facts).symbol}`, `${pretty} out of ${formatAmount(balance, o.asset, facts)} held.`);
    }
  }

  // ---- who receives ----
  const missing = new Map<string, boolean>(); // account -> receives NEAR?
  const unknownRecipients = new Set<string>();
  for (const o of outflows) {
    if (isNearAccountId(o.to) && !isImplicit(o.to) && facts.accountExists[o.to] === undefined) unknownRecipients.add(o.to);
    if (isNearAccountId(o.to) && !isImplicit(o.to) && facts.accountExists[o.to] === false) {
      missing.set(o.to, (missing.get(o.to) ?? false) || o.asset.kind === "near");
    }
  }
  if (missing.size) {
    const list = [...missing.keys()];
    const anyNear = [...missing.values()].some(Boolean);
    add(
      "recipient-missing",
      anyNear ? "high" : "medium",
      list.length === 1 ? `Recipient ${list[0]} does not exist` : `${list.length} recipients do not exist`,
      `${list.slice(0, 5).join(", ")}${list.length > 5 ? ` and ${list.length - 5} more` : ""}. ` +
        (anyNear
          ? "Named accounts must exist before they can receive NEAR. Check for a typo: the transfer will fail."
          : "Token transfers to them will fail, or land at an account nobody controls yet."),
    );
  }
  for (const o of outflows) {
    if (o.to === p.proposer && approvers.has(p.proposer)) {
      add(
        "self-dealing",
        "medium",
        "An approver pays themself",
        `${formatAmount(o.amount, o.asset, facts)} goes to ${p.proposer}, who proposed it and can also vote to approve it. Their own vote counts toward the threshold.`,
      );
    }
    if (o.crossChain) {
      add("cross-chain", "info", "Funds leave NEAR", `${formatAmount(o.amount, o.asset, facts)} is withdrawn through NEAR Intents to ${o.to} on another chain. NEAR cannot check that address.`);
    }
  }

  // ---- description vs payload ----
  const claimed = mentionedAmounts([desc.text, ...Object.values(desc.fields)].join("\n"));
  if (claimed.length && outflows.length) {
    const actual = outflows
      .map((o) => {
        const info = assetInfo(o.asset, facts);
        return info.decimals === null ? null : { sym: normSym(info.symbol), label: info.symbol, value: toNumber(o.amount, info.decimals) };
      })
      .filter((x): x is { sym: string; label: string; value: number } => !!x);
    const comparable = claimed.filter((c) => actual.some((a) => sameUnit(a.sym, c.symbol)));
    if (comparable.length && actual.length) {
      const hits = comparable.filter((c) => actual.some((a) => sameUnit(a.sym, c.symbol) && close(a.value, c.value)));
      const misses = comparable.filter((c) => !hits.includes(c));
      const does = actual.map((a) => `${round(a.value)} ${a.label}`).join(", ");
      const fmt = (xs: typeof comparable) => [...new Set(xs.map((c) => `${round(c.value)} ${c.symbol}`))].join(", ");
      if (!hits.length) {
        add("description-mismatch", "high", "Description and payload disagree", `The text says ${fmt(comparable)}; the proposal actually sends ${does}.`);
      } else if (misses.length) {
        // One number in the text matches, others do not. The match may be a budget or total,
        // not the payment, so say it is ambiguous instead of treating it as confirmed.
        add(
          "ambiguous-amount",
          "medium",
          "Text mentions several amounts",
          `The text mentions ${fmt(comparable)}; the proposal sends ${does}. Confirm which number is the payment.`,
        );
      }
    }
  }
  const undecimaled = outflows.filter((o) => o.asset.kind !== "nft" && assetInfo(o.asset, facts).decimals === null);
  if (undecimaled.length) unchecked.push(`Token metadata unavailable for ${[...new Set(undecimaled.map((o) => assetInfo(o.asset, facts).symbol))].join(", ")}: amounts shown raw, text amounts not compared.`);

  // ---- Trezu-style claimed action vs payload ----
  const claimedAction = desc.fields["proposal action"] ?? null;
  if (claimedAction) {
    const ok = claimedActionMatches(claimedAction, decoded);
    if (ok === false) {
      add("label-mismatch", "high", `Labelled "${claimedAction}" but does something else`, `Treasury apps sort proposals by this label, which the proposer writes. The payload is ${summaryOfKind(decoded)}.`);
    }
  }

  // ---- batches: more than one action that moves funds or control ----
  // Wrapping NEAR or paying storage first is routine (Trezu pays NEAR as near_deposit + ft_transfer),
  // so only actions that move value or control count.
  if (decoded.calls.length > 1) {
    const movers = [...new Set(decoded.effects.filter((e) => e.type === "outflow" || e.type === "control").map((e) => e.actionIndex))].sort((a, b) => a - b);
    const extra = movers.slice(1);
    if (extra.length) {
      const controlLater = decoded.effects.some((e) => e.type === "control" && extra.includes(e.actionIndex));
      const singlePaymentLabel = /^payment(-transfer)?$/i.test((claimedAction ?? "").trim());
      const recipients = new Set(outflows.map((o) => o.to));
      if (controlLater || singlePaymentLabel) {
        add(
          "hidden-action",
          "high",
          `Action #${extra.map((i) => i + 1).join(", #")} also moves funds or control`,
          `${singlePaymentLabel ? `Labelled as a single payment, but ${movers.length} actions move value or control. ` : ""}Summary views usually show the first action only. Every action below runs if this passes.`,
        );
      } else {
        add("multi-payout", "medium", `${movers.length} transfers in one proposal`, `Pays ${recipients.size} recipient${recipients.size === 1 ? "" : "s"} in one vote. Check each line below; they all run together.`);
      }
    } else if (decoded.calls.length > 3) {
      add("batch", "medium", `Batch of ${decoded.calls.length} calls`, "Review every call; they all run atomically in order.");
    }
  }

  // Trezu bulk payments: the recipient list lives in bulkpayment.near, keyed by the msg.
  for (const c of decoded.calls) {
    if (c.args.kind === "json" && c.args.value?.receiver_id === "bulkpayment.near") {
      unchecked.push(`Individual recipients are stored in bulk list ${String(c.args.value.msg ?? "?").slice(0, 16)}… on bulkpayment.near; X-Ray checks the total, not each recipient.`);
    }
  }

  if (unknownRecipients.size) {
    const list = [...unknownRecipients];
    unchecked.push(`Could not confirm that ${list.slice(0, 3).join(", ")}${list.length > 3 ? ` and ${list.length - 3} more` : ""} exist${list.length === 1 ? "s" : ""}.`);
  }

  // ---- raw calls ----
  const unknownMethods = decoded.calls.filter((c) => !c.known);
  for (const c of unknownMethods) {
    unchecked.push(`X-Ray does not model ${c.method} on ${c.receiver}: what it does depends on that contract. Read call #${c.index + 1}'s arguments below.`);
  }
  const unseenReceivers = [...new Set(decoded.calls.map((c) => c.receiver))].filter((r) => r !== ctx.daoId && facts.accountExists[r] === undefined);
  if (unseenReceivers.length) unchecked.push(`Could not confirm that contract ${unseenReceivers.join(", ")} exists or has code.`);
  for (const c of decoded.calls) {
    if (c.args.kind === "binary") {
      add("opaque-args", "medium", `Call #${c.index + 1} has unreadable arguments`, `${c.method} on ${c.receiver} receives ${c.args.length} bytes of binary data that no wallet can show.`);
    }
    if (c.receiver === ctx.daoId) {
      add("self-call", "high", `The DAO calls itself (${c.method})`, "A FunctionCall back into the DAO can change state that normally needs its own proposal type.");
    }
    if (facts.accountExists[c.receiver] === false) {
      add("call-missing", "medium", `Calls ${c.receiver}, which does not exist`, "The call will fail.");
    } else if (facts.hasCode[c.receiver] === false && c.receiver !== ctx.daoId) {
      add("call-no-code", "medium", `Calls ${c.receiver}, which has no contract`, `${c.method} will fail; any attached deposit is refunded.`);
    }
  }
  for (const e of decoded.effects) {
    if (e.type === "control" && e.method !== "ft_transfer" && e.method !== "ft_transfer_call") {
      const sev: Severity = /owner|admin|super_admin|full_access|guardian|grant_role|upgrade|update_contract|deploy|set_code|migrate/.test(e.method) ? "critical" : "high";
      add("control-change", sev, `Changes control of ${e.target}`, `${e.detail}. Approving this hands power over another contract.`);
    }
  }

  // ---- code upgrades ----
  if ("UpgradeSelf" in (typeof k === "object" ? k : {})) {
    const hash = k.UpgradeSelf.hash as string;
    if (!ctx.knownCodeHashes.length) {
      // No release list: never claim a match we could not check.
      add("upgrade-unverified", "critical", "Replaces the DAO's code; hash could not be verified", `The list of official Sputnik releases (sputnik-dao.near get_contracts_metadata) could not be loaded, so code hash ${hash} is unchecked. Treat it as unknown code until verified.`);
      unchecked.push("Official Sputnik release list unavailable: the upgrade's code hash was not verified.");
    } else if (!ctx.knownCodeHashes.includes(hash)) {
      add("upgrade-unknown", "critical", "Replaces the DAO's code with unknown code", `Code hash ${hash} is not a Sputnik release known to sputnik-dao.near. Whoever wrote it can take everything.`);
    } else {
      add("upgrade-known", "high", "Upgrades the DAO's code", `Hash ${hash} matches Sputnik ${ctx.versions?.[hash] ?? "release"} published by the factory.`);
    }
  }
  if (typeof k === "object" && "UpgradeRemote" in k) {
    add("upgrade-remote", "high", `Deploys code to ${k.UpgradeRemote.receiver_id}`, `Calls ${k.UpgradeRemote.method_name} with code hash ${k.UpgradeRemote.hash}.`);
  }
  if (typeof k === "object" && "SetStakingContract" in k) {
    add("staking-contract", "high", "Switches voting to token weight", `Sets ${k.SetStakingContract.staking_id} as the staking contract. Token-weighted roles then follow whoever holds that token.`);
  }

  // ---- policy changes ----
  let policyDiff: PolicyDiff | null = null;
  // The diff is computed against TODAY's policy, so it only means something while the
  // proposal is still open. A finished proposal's change is already part of today's policy.
  if (isPolicyKind(p.kind) && live) {
    const after = applyPolicyChange(ctx.policy, p.kind);
    if (after) {
      policyDiff = diffPolicies(ctx.policy, after);
      const single: string[] = [];
      const fewer: string[] = [];
      const fresh: string[] = [];
      for (const line of policyDiff.lines) {
        const b = line.before?.n ?? null;
        const a = line.after?.n ?? null;
        if (a !== null && a === 1 && (b === null || b > 1)) single.push(`${line.label} (role "${line.after!.role}", today ${b ?? "none"})`);
        else if (a !== null && b !== null && a < b) fewer.push(`${line.label}: ${b} → ${a}`);
        else if (a !== null && b === null && line.label !== "upgrade_self") fresh.push(`${line.label} via "${line.after!.role}" (${a})`);
      }
      if (single.length) add("single-signer", "critical", "One account could approve alone", `After this change a single vote passes: ${single.join("; ")}.`);
      if (fewer.length) add("fewer-signers", "high", "Fewer approvals needed", fewer.join("; ") + ".");
      if (fresh.length) add("new-approval-path", "medium", "New way to approve", fresh.join("; ") + ".");
      for (const r of after.roles) {
        if (r.kind === "Everyone" && r.permissions.some((perm) => /:(VoteApprove|\*)$/.test(perm) || perm === "*:*")) {
          const before = ctx.policy.roles.find((x) => x.name === r.name);
          if (!before || JSON.stringify(before.permissions) !== JSON.stringify(r.permissions)) {
            add("everyone-votes", "medium", `Anyone on NEAR can vote in role "${r.name}"`, "Sputnik ignores Everyone roles when counting thresholds, but their votes still show up and can confuse members.");
          }
        }
      }
      if (policyDiff.periodAfter < policyDiff.periodBefore && policyDiff.periodAfter < 86_400_000_000_000n) {
        add("short-period", "high", "Voting window shrinks", `${durationNs(policyDiff.periodBefore)} → ${durationNs(policyDiff.periodAfter)}. Members get less time to notice future proposals.`);
      }
      const remaining = membersOf(after);
      for (const m of policyDiff.removedMembers) {
        if (m === p.proposer) continue;
        add("member-removed", remaining.size <= 2 ? "high" : "info", `Removes ${m}`, `Member set: ${members.size} → ${remaining.size}.`);
      }
      for (const m of policyDiff.addedMembers) {
        const sev: Severity = m === p.proposer ? "high" : "info";
        add("member-added", sev, m === p.proposer ? "Proposer adds themself" : `Adds ${m}`, `Member set: ${members.size} → ${remaining.size}.`);
      }
    } else if (typeof k === "object" && "ChangePolicy" in k) {
      add("policy-replaced", "high", "Replaces the whole policy", "The new policy could not be compared field by field; read it below.");
    }
  }

  // ---- proposer context ----
  if (!members.has(p.proposer)) {
    add("outsider", "info", "Proposed by a non-member", `${p.proposer} is not in any group role. Anyone may propose here (bond: ${formatUnits(BigInt(ctx.policy.proposal_bond), 24)} NEAR).`);
  }

  // ---- votes ----
  if (live && votes.remaining === 1) {
    add("one-vote-away", "info", "One more approval passes it", "Review now: the next approval executes it.");
  }

  flags.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return {
    daoId: ctx.daoId,
    id: p.id,
    proposer: p.proposer,
    status: votes.expired && p.status === "InProgress" ? "Expired" : p.status,
    submittedAtMs: Number(BigInt(p.submission_time) / 1_000_000n),
    description: {
      raw: p.description ?? "",
      title: desc.fields["title"] ?? desc.text.split("\n")[0]?.slice(0, 160) ?? "",
      claimedAction,
      fields: desc.fields,
    },
    decoded,
    summary: summarize(decoded, p, ctx, facts, label),
    flags: dedupe(flags),
    votes,
    policyDiff,
    worst: flags[0]?.severity ?? null,
    unchecked: [...new Set(unchecked)],
  };
}

/** Headline state: worst finding, or "partial" when nothing was found but some checks could not run. */
export function verdictOf(r: Pick<Report, "worst" | "unchecked">): Severity | "partial" | "clean" {
  if (r.worst && r.worst !== "info") return r.worst;
  if (r.unchecked.length) return "partial";
  return r.worst ?? "clean";
}

function dedupe(flags: Flag[]): Flag[] {
  const seen = new Set<string>();
  return flags.filter((f) => {
    const key = f.id + "|" + f.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function voteState(p: Proposal, ctx: DaoContext, nowMs = Date.now()): VoteState {
  const label = labelOf(p.kind);
  const paths = approvalPaths(ctx.policy, label).map((path) => {
    const counts = p.vote_counts?.[path.role];
    const approvals = counts ? Number(counts[0]) : 0;
    return {
      role: path.role,
      weighting: path.weighting,
      approvals,
      needed: path.needed === null ? null : Number(path.needed),
      members: path.members.length,
    };
  });
  let remaining: number | null = null;
  for (const path of paths) {
    if (path.weighting !== "group" || path.needed === null || path.members === 0) continue;
    const r = Math.max(0, path.needed - path.approvals);
    if (remaining === null || r < remaining) remaining = r;
  }
  const submitted = Number(BigInt(p.submission_time) / 1_000_000n);
  const expiresAtMs = submitted + Number(BigInt(ctx.policy.proposal_period) / 1_000_000n);
  return { label, paths, remaining, expiresAtMs, expired: nowMs > expiresAtMs };
}

function summarize(d: Decoded, p: Proposal, ctx: DaoContext, facts: ChainFacts, label: string): string[] {
  const lines: string[] = [];
  const k = p.kind as any;
  const ordered = [...d.effects].sort((a, b) => Number(a.type === "storage") - Number(b.type === "storage"));
  for (const e of ordered) {
    switch (e.type) {
      case "outflow": {
        const who = describeAccount(e.to);
        lines.push(`Sends ${formatAmount(e.amount, e.asset, facts)} to ${e.to}${who ? ` (${who})` : ""} — ${e.via}.`);
        break;
      }
      case "stake": {
        const amt = e.amount === "all" ? "everything" : `${formatUnits(e.amount, 24)} NEAR`;
        lines.push(`${e.direction === "stake" ? "Stakes" : e.direction === "unstake" ? "Unstakes" : "Withdraws"} ${amt} ${e.direction === "stake" ? "with" : "from"} validator ${e.pool}.`);
        break;
      }
      case "wrap":
        lines.push(`${e.direction === "wrap" ? "Wraps" : "Unwraps"} ${formatUnits(e.amount, 24)} NEAR ${e.direction === "wrap" ? "into" : "from"} wNEAR (stays in the treasury).`);
        break;
      case "control":
        lines.push(`On ${e.target}: ${e.detail}.`);
        break;
      case "storage":
        lines.push(`Pays ${formatUnits(e.amount, 24)} NEAR storage/registration on ${e.target}.`);
        break;
    }
  }
  if (typeof k === "object") {
    if ("AddMemberToRole" in k) lines.push(`Adds ${k.AddMemberToRole.member_id} to role "${k.AddMemberToRole.role}".`);
    if ("RemoveMemberFromRole" in k) lines.push(`Removes ${k.RemoveMemberFromRole.member_id} from role "${k.RemoveMemberFromRole.role}".`);
    if ("ChangeConfig" in k) lines.push(`Renames/re-describes the DAO: "${k.ChangeConfig.config.name}".`);
    if ("UpgradeSelf" in k) lines.push(`Replaces the DAO contract code (hash ${k.UpgradeSelf.hash}).`);
    if ("BountyDone" in k) lines.push(`Marks bounty #${k.BountyDone.bounty_id} done and pays ${k.BountyDone.receiver_id}.`);
    if ("ChangePolicy" in k || String(Object.keys(k)[0]).startsWith("ChangePolicy")) lines.push("Changes who can do what in this DAO (see policy diff).");
  }
  if (p.kind === "Vote") lines.push("Signalling vote only: nothing executes on-chain.");
  // Calls that produced no modelled effect still get a line, so nothing is silently skipped.
  const withEffect = new Set(d.effects.map((e) => e.actionIndex));
  for (const c of d.calls) {
    if (withEffect.has(c.index)) continue;
    const who = describeAccount(c.receiver);
    lines.push(`Calls ${c.method} on ${c.receiver}${who ? ` (${who})` : ""}${c.known ? "" : " — effect not modelled by X-Ray"}.`);
  }
  if (!lines.length) lines.push(`${label} proposal with no on-chain side effects we can decode.`);
  void ctx;
  return lines;
}

function summaryOfKind(d: Decoded): string {
  if (d.calls.length) return d.calls.map((c) => `${c.method} on ${c.receiver}`).join(", ");
  return d.variant;
}

/** Trezu's proposal_action values and what payload each implies. Unknown labels return null (no opinion). */
export function claimedActionMatches(action: string, d: Decoded): boolean | null {
  const a = action.toLowerCase().trim();
  const methods = d.calls.map((c) => c.method);
  const hasOutflow = d.effects.some((e) => e.type === "outflow");
  switch (a) {
    case "payment-transfer":
    case "payment":
      return d.variant === "Transfer" || hasOutflow;
    case "asset-exchange":
      // Trezu swaps go through NEAR Intents, Rhea, or a 1Click deposit address (plain ft_transfer).
      return d.calls.some((c) => c.receiver === "intents.near" || c.receiver === "v2.ref-finance.near" || /swap|ft_transfer|mt_transfer/.test(c.method));
    case "bulk-payment":
      return d.calls.some((c) => c.receiver === "bulkpayment.near" || (c.args.kind === "json" && c.args.value?.receiver_id === "bulkpayment.near"));
    case "stake":
    case "earn-near":
      return methods.some((m) => m === "deposit_and_stake" || m === "deposit");
    case "unstake":
    case "unstake-near":
      return methods.some((m) => m.startsWith("unstake"));
    case "withdraw":
    case "withdraw-earnings":
      return methods.some((m) => m.startsWith("withdraw"));
    default:
      return null;
  }
}

function normSym(s: string): string {
  const u = s.toUpperCase();
  if (u === "WNEAR") return "NEAR";
  if (u === "USDT" || u === "USDT.E" || u === "USDC" || u === "USDC.E" || u === "DAI") return "USD";
  return u;
}

function sameUnit(actualSym: string, claimedSym: string): boolean {
  return normSym(actualSym) === normSym(claimedSym);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);
}

function round(v: number): string {
  return v >= 100 ? v.toFixed(0) : String(+v.toFixed(4));
}

export { minSigners, roleAllows, ftContractOf };
