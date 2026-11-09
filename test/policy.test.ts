import { describe, expect, it } from "vitest";
import { applyPolicyChange, diffPolicies, minSigners, toWeight, approvalPaths } from "../src/policy.ts";
import { policy } from "./helpers.ts";

describe("toWeight mirrors sputnikdao2 policy.rs", () => {
  // Cases copied from the contract's own test_vote_policy.
  it("matches the contract's unit tests", () => {
    expect(toWeight("100", 1_000_000n)).toBe(100n);
    expect(toWeight([1, 2], 2n)).toBe(2n);
    expect(toWeight([1, 2], 5n)).toBe(3n);
    expect(toWeight([1, 1], 5n)).toBe(5n);
  });
});

describe("minSigners", () => {
  it("half+1 of a 3-member council is 2", () => {
    expect(minSigners(policy(["a.near", "b.near", "c.near"]), "transfer")).toEqual({ n: 2, role: "Council" });
  });
  it("a 1-member council can pass alone", () => {
    expect(minSigners(policy(["a.near"]), "transfer")?.n).toBe(1);
  });
  it("ignores Everyone roles, as the contract does", () => {
    const p = policy(["a.near", "b.near"]);
    p.roles[1].permissions.push("*:VoteApprove");
    expect(approvalPaths(p, "transfer").map((x) => x.role)).toEqual(["Council"]);
  });
  it("respects per-kind vote policy and quorum", () => {
    const p = policy(["a.near", "b.near", "c.near", "d.near"]);
    p.roles[0].vote_policy = { transfer: { weight_kind: "RoleWeight", quorum: "3", threshold: [1, 4] } };
    expect(minSigners(p, "transfer")?.n).toBe(3);
    expect(minSigners(p, "call")?.n).toBe(3); // default 1/2 of 4 → 3
  });
  it("returns null when nobody may approve", () => {
    const p = policy(["a.near"]);
    p.roles[0].permissions = ["*:AddProposal"];
    expect(minSigners(p, "transfer")).toBeNull();
  });
});

describe("policy diff", () => {
  it("detects that removing members turns a 2-of-3 into a 1-of-1", () => {
    const before = policy(["a.near", "b.near", "c.near"]);
    let after = applyPolicyChange(before, { RemoveMemberFromRole: { member_id: "b.near", role: "Council" } })!;
    after = applyPolicyChange(after, { RemoveMemberFromRole: { member_id: "c.near", role: "Council" } })!;
    const d = diffPolicies(before, after);
    expect(d.removedMembers.sort()).toEqual(["b.near", "c.near"]);
    expect(d.lines.find((l) => l.label === "transfer")).toMatchObject({ before: { n: 2 }, after: { n: 1 } });
  });
  it("does not mutate the input policy", () => {
    const before = policy(["a.near", "b.near"]);
    applyPolicyChange(before, { AddMemberToRole: { member_id: "x.near", role: "Council" } });
    expect((before.roles[0].kind as { Group: string[] }).Group).toEqual(["a.near", "b.near"]);
  });
});
