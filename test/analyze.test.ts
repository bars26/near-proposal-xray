import { describe, expect, it } from "vitest";
import { analyze, verdictOf } from "../src/analyze.ts";
import { decodeArgs, mentionedAmounts, parseDescription } from "../src/decode.ts";
import { DAO, NEAR, NOW, b64, call, ctx, facts, policy, proposal } from "./helpers.ts";

const ids = (r: ReturnType<typeof analyze>) => r.flags.map((f) => f.id);
const USDT = "usdt.tether-token.near";

describe("decoding", () => {
  it("decodes JSON, text and binary args", () => {
    expect(decodeArgs(b64({ a: 1 }))).toEqual({ kind: "json", value: { a: 1 } });
    expect(decodeArgs("")).toEqual({ kind: "empty" });
    expect(decodeArgs(Buffer.from([0, 1, 2, 255, 0]).toString("base64")).kind).toBe("binary");
  });
  it("parses Trezu markdown descriptions", () => {
    const d = parseDescription("* Proposal Action: payment-transfer <br>* Title: Pay designer <br>* Summary: 500 USDt for logo");
    expect(d.fields["proposal action"]).toBe("payment-transfer");
    expect(d.fields["title"]).toBe("Pay designer");
  });
  it("finds amounts in prose", () => {
    expect(mentionedAmounts("Pay 1,250.5 NEAR and $300")).toEqual([
      { value: 1250.5, symbol: "NEAR" },
      { value: 300, symbol: "USD" },
    ]);
  });
});

describe("clean proposals stay clean", () => {
  it("a small USDt payment to a non-member with a matching description has no warnings", () => {
    const p = proposal(call(USDT, { method: "ft_transfer", args: { receiver_id: "designer.near", amount: "500000000" }, deposit: 1n }), {
      description: "* Proposal Action: payment-transfer <br>* Title: Logo work <br>* Summary: 500 USDT for the new logo",
    });
    const r = analyze(p, ctx(), facts({ accountExists: { "designer.near": true, [USDT]: true }, hasCode: { [USDT]: true } }), NOW);
    expect(r.flags.filter((f) => f.severity !== "info")).toEqual([]);
    expect(r.summary[0]).toContain("500 USDt to designer.near");
    expect(r.votes.remaining).toBe(2);
  });
});

describe("never claim more than was checked", () => {
  it("an upgrade is not called official when the release list is unavailable", () => {
    const c = ctx();
    c.knownCodeHashes = [];
    const r = analyze(proposal({ UpgradeSelf: { hash: "EvilHash" } }), c, facts(), NOW);
    expect(r.flags[0]).toMatchObject({ id: "upgrade-unverified", severity: "critical" });
    expect(r.flags.map((f) => f.detail).join(" ")).not.toMatch(/matches/);
    expect(r.unchecked.join(" ")).toMatch(/release list unavailable/);
  });

  it("an unknown method with no chain data is partly checked, not clean", () => {
    const r = analyze(proposal(call("mystery.near", { method: "do_thing", args: { x: 1 } })), ctx(), { accountExists: {}, hasCode: {}, tokens: {}, daoTokenBalance: {} }, NOW);
    expect(r.flags.filter((f) => f.severity !== "info")).toEqual([]);
    expect(verdictOf(r)).toBe("partial");
    expect(r.unchecked.join(" ")).toMatch(/does not model do_thing on mystery\.near/);
    expect(r.unchecked.join(" ")).toMatch(/Could not confirm that contract mystery\.near/);
    expect(r.summary.join(" ")).toMatch(/do_thing.*not modelled/);
  });

  it("a fully checked routine payment is clean with nothing unchecked", () => {
    const p = proposal(call(USDT, { method: "ft_transfer", args: { receiver_id: "designer.near", amount: "500000000" }, deposit: 1n }), { proposer: "designer.near" });
    const r = analyze(p, ctx(), facts({ accountExists: { "designer.near": true, [USDT]: true }, hasCode: { [USDT]: true } }), NOW);
    expect(r.unchecked).toEqual([]);
  });

  it("a second number in the text does not count as confirmation", () => {
    const p = proposal(call(USDT, { method: "ft_transfer", args: { receiver_id: "x.near", amount: "5000000000" }, deposit: 1n }), {
      description: "Pay 500 USDT, treasury budget 5,000 USDT",
      proposer: "x.near",
    });
    const f = analyze(p, ctx(), facts(), NOW).flags.find((x) => x.id === "ambiguous-amount");
    expect(f?.severity).toBe("medium");
    expect(f?.detail).toBe("The text mentions 500 USDT, 5000 USDT; the proposal sends 5000 USDt. Confirm which number is the payment.");
  });

  it("a single matching amount stays quiet", () => {
    const p = proposal(call(USDT, { method: "ft_transfer", args: { receiver_id: "x.near", amount: "500000000" }, deposit: 1n }), { description: "Pay 500 USDT", proposer: "x.near" });
    const ids = analyze(p, ctx(), facts(), NOW).flags.map((x) => x.id);
    expect(ids).not.toContain("ambiguous-amount");
    expect(ids).not.toContain("description-mismatch");
  });
});

// Shapes taken from real mainnet proposals that the first calibration run flagged wrongly.
describe("real Trezu patterns stay quiet", () => {
  it("1Click swap: near_deposit + ft_transfer of wNEAR to a deposit address", () => {
    const p = proposal(
      call(
        "wrap.near",
        { method: "near_deposit", deposit: 154n * NEAR },
        { method: "ft_transfer", args: { receiver_id: "8ef46344865cd425903e1601f0dd4ad9d72a7607b2606ff180a2c45882db40b7", amount: (154n * NEAR).toString() }, deposit: 1n },
      ),
      { description: "* Proposal Action: asset-exchange <br>* Token In Address: near <br>* Amount In: 154 <br>* Amount Out: 559.830714" },
    );
    const got = ids(analyze(p, ctx(), facts(), NOW));
    expect(got).not.toContain("hidden-action");
    expect(got).not.toContain("label-mismatch");
    expect(got).not.toContain("multi-payout");
  });

  it("bulk payment: 'Recipients: 3' on one line and 'Contract: USDC.e' on the next is not '3 USDC'", () => {
    const p = proposal(
      call(USDT, { method: "ft_transfer_call", args: { receiver_id: "bulkpayment.near", amount: "1260000000", msg: "4dfe46f3" }, deposit: 1n }),
      { description: "* Proposal Action: bulk-payment <br>* Recipients: 3 <br>* Contract: USDT <br>* Amount: 1260" },
    );
    const r = analyze(p, ctx(), facts(), NOW);
    expect(ids(r)).not.toContain("description-mismatch");
    expect(ids(r)).not.toContain("label-mismatch");
    expect(r.unchecked.join(" ")).toMatch(/bulk list/);
  });

  it("an explicit multi-recipient refund is a 'check', not a hidden action", () => {
    const p = proposal(
      call(
        USDT,
        { method: "ft_transfer", args: { receiver_id: "a.near", amount: "100" }, deposit: 1n },
        { method: "ft_transfer", args: { receiver_id: "b.near", amount: "200" }, deposit: 1n },
      ),
      { description: "Refund token to users" },
    );
    const f = analyze(p, ctx(), facts(), NOW).flags;
    expect(f.map((x) => x.id)).not.toContain("hidden-action");
    expect(f.find((x) => x.id === "multi-payout")?.severity).toBe("medium");
  });

  it("a later control change is still high even without a payment label", () => {
    const p = proposal(
      call("token.acme.near", { method: "ft_transfer", args: { receiver_id: "a.near", amount: "1" }, deposit: 1n }, { method: "set_owner", args: { owner_id: "mallory.near" } }),
    );
    expect(analyze(p, ctx(), facts(), NOW).flags.find((x) => x.id === "hidden-action")?.severity).toBe("high");
  });
});

describe("risk rules", () => {
  it("hidden-action: a payment whose second action moves more funds", () => {
    const p = proposal(
      call(
        USDT,
        { method: "ft_transfer", args: { receiver_id: "designer.near", amount: "500000000" }, deposit: 1n },
        { method: "ft_transfer", args: { receiver_id: "mallory.near", amount: "9000000000" }, deposit: 1n },
      ),
      { description: "* Proposal Action: payment-transfer <br>* Title: Logo work <br>* Summary: 500 USDT" },
    );
    const r = analyze(p, ctx(), facts(), NOW);
    expect(ids(r)).toContain("hidden-action");
    expect(r.flags.find((f) => f.id === "treasury-share")?.severity).toBe("critical"); // 9,500 of 10,000
    expect(r.worst).toBe("critical");
  });

  it("description-mismatch: text says 500, payload sends 5,000", () => {
    const p = proposal(call(USDT, { method: "ft_transfer", args: { receiver_id: "designer.near", amount: "5000000000" }, deposit: 1n }), {
      description: "Pay designer 500 USDT for the logo",
    });
    expect(ids(analyze(p, ctx(), facts(), NOW))).toContain("description-mismatch");
  });

  it("label-mismatch: labelled payment, actually hands over contract ownership", () => {
    const p = proposal(call("token.acme.near", { method: "set_owner", args: { owner_id: "mallory.near" } }), {
      description: "* Proposal Action: payment-transfer <br>* Title: Monthly payroll",
    });
    const r = analyze(p, ctx(), facts(), NOW);
    expect(ids(r)).toEqual(expect.arrayContaining(["label-mismatch", "control-change"]));
    expect(r.flags.find((f) => f.id === "control-change")?.severity).toBe("critical");
  });

  it("upgrade-unknown: UpgradeSelf to a hash the factory never published", () => {
    const r = analyze(proposal({ UpgradeSelf: { hash: "EvilHash1111111111111111111111111111111111" } }), ctx(), facts(), NOW);
    expect(r.flags[0]).toMatchObject({ id: "upgrade-unknown", severity: "critical" });
  });

  it("upgrade-known: UpgradeSelf to an official release is high, not critical", () => {
    const r = analyze(proposal({ UpgradeSelf: { hash: "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF" } }), ctx(), facts(), NOW);
    expect(r.flags[0]).toMatchObject({ id: "upgrade-known", severity: "high" });
  });

  it("single-signer: a role change that lets one account approve alone", () => {
    const r = analyze(
      proposal({
        ChangePolicyAddOrUpdateRole: {
          role: { name: "ops", kind: { Group: ["alice.near"] }, permissions: ["transfer:VoteApprove", "transfer:AddProposal"], vote_policy: {} },
        },
      }),
      ctx(),
      facts(),
      NOW,
    );
    expect(r.flags.find((f) => f.id === "single-signer")?.severity).toBe("critical");
    expect(r.policyDiff?.roleChanges[0]).toContain('new role "ops"');
  });

  it("policy rules skip finished proposals (their change is already in today's policy)", () => {
    const kind = { RemoveMemberFromRole: { member_id: "bob.near", role: "Council" } };
    const r = analyze(proposal(kind, { status: "Approved" }), ctx(policy(["alice.near", "bob.near"])), facts(), NOW);
    expect(ids(r)).not.toContain("single-signer");
    const open = analyze(proposal(kind), ctx(policy(["alice.near", "bob.near"])), facts(), NOW);
    expect(ids(open).filter((i) => i === "single-signer")).toHaveLength(1);
  });

  it("many missing recipients collapse into one warning", () => {
    const actions = ["l0.x.near", "l1.x.near", "l2.x.near"].map((to) => ({ method: "ft_transfer", args: { receiver_id: to, amount: "1" }, deposit: 1n }));
    const r = analyze(proposal(call(USDT, ...actions)), ctx(), facts({ accountExists: { "l0.x.near": false, "l1.x.near": false, "l2.x.near": false } }), NOW);
    const f = r.flags.filter((x) => x.id === "recipient-missing");
    expect(f).toHaveLength(1);
    expect(f[0].title).toBe("3 recipients do not exist");
  });

  it("self-dealing: a council member proposes paying themself", () => {
    const p = proposal({ Transfer: { token_id: "", receiver_id: "alice.near", amount: (5n * NEAR).toString() } });
    expect(ids(analyze(p, ctx(), facts(), NOW))).toContain("self-dealing");
  });

  it("an outside applicant paying themself is not self-dealing", () => {
    const p = proposal({ Transfer: { token_id: "", receiver_id: "dev.near", amount: (5n * NEAR).toString() } }, { proposer: "dev.near" });
    const r = analyze(p, ctx(), facts(), NOW);
    expect(ids(r)).not.toContain("self-dealing");
    expect(ids(r)).toContain("outsider");
  });

  it("recipient-missing: NEAR sent to a named account that does not exist", () => {
    const p = proposal({ Transfer: { token_id: "", receiver_id: "alcie.near", amount: NEAR.toString() } });
    const r = analyze(p, ctx(), facts({ accountExists: { "alcie.near": false } }), NOW);
    expect(r.flags.find((f) => f.id === "recipient-missing")?.severity).toBe("high");
  });

  it("treasury checks only apply to open proposals", () => {
    const p = proposal({ Transfer: { token_id: "", receiver_id: "x.near", amount: (900n * NEAR).toString() } }, { status: "Approved" });
    expect(ids(analyze(p, ctx(), facts(), NOW))).not.toContain("treasury-share");
  });

  it("cross-chain: NEAR Intents withdrawal to an external address", () => {
    const p = proposal(
      call("intents.near", {
        method: "ft_withdraw",
        args: { token: "eth.omft.near", receiver_id: "eth.omft.near", amount: "1000", memo: "WITHDRAW_TO:0xabc0000000000000000000000000000000000001" },
        deposit: 1n,
      }),
    );
    const r = analyze(p, ctx(), facts(), NOW);
    expect(ids(r)).toContain("cross-chain");
    expect(r.summary[0]).toContain("0xabc0000000000000000000000000000000000001");
  });

  it("self-call and opaque args", () => {
    const p = proposal({
      FunctionCall: { receiver_id: DAO, actions: [{ method_name: "store_blob", args: Buffer.from([0, 9, 200, 1]).toString("base64"), deposit: "0", gas: "1" }] },
    });
    expect(ids(analyze(p, ctx(), facts(), NOW))).toEqual(expect.arrayContaining(["self-call", "opaque-args"]));
  });

  it("one-vote-away and expiry", () => {
    const p = proposal({ Transfer: { token_id: "", receiver_id: "x.near", amount: "1" } }, { vote_counts: { Council: [1, 0, 0] } });
    const r = analyze(p, ctx(policy(["a.near", "b.near", "c.near"])), facts(), NOW);
    expect(r.votes.remaining).toBe(1);
    expect(ids(r)).toContain("one-vote-away");
    const old = analyze({ ...p, submission_time: "1" }, ctx(), facts(), NOW);
    expect(old.status).toBe("Expired");
  });

  it("staking moves are not counted as outflows", () => {
    const p = proposal(call("astro-stakers.poolv1.near", { method: "deposit_and_stake", deposit: 600n * NEAR }));
    const r = analyze(p, ctx(), facts(), NOW);
    expect(ids(r)).not.toContain("treasury-share");
    expect(r.summary[0]).toContain("Stakes 600 NEAR");
  });
});
