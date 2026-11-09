// Crafted proposals that show each rule firing. They are analysed against a demo DAO
// (no chain writes), so anyone can reproduce every warning in the README.

import type { DaoContext, ChainFacts, Proposal, ProposalKind } from "./types.ts";

const NEAR = 10n ** 24n;
const USDT = "usdt.tether-token.near";

function b64(o: unknown) {
  const s = JSON.stringify(o);
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function fc(receiver_id: string, actions: { method: string; args?: unknown; deposit?: bigint }[]): ProposalKind {
  return {
    FunctionCall: {
      receiver_id,
      actions: actions.map((a) => ({ method_name: a.method, args: a.args === undefined ? "" : b64(a.args), deposit: String(a.deposit ?? 0n), gas: "100000000000000" })),
    },
  };
}

export const DEMO_DAO = "demo-treasury.sputnik-dao.near";

export function demoContext(now = Date.now()): { ctx: DaoContext; facts: ChainFacts; now: number } {
  return {
    now,
    ctx: {
      daoId: DEMO_DAO,
      nearBalance: 2_000n * NEAR,
      knownCodeHashes: ["DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF"],
      versions: { DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF: "v3.2" },
      codeHash: "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF",
      policy: {
        roles: [
          {
            name: "Approvers",
            kind: { Group: ["alice.near", "bob.near", "carol.near"] },
            permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
            vote_policy: {},
          },
          { name: "Requestors", kind: "Everyone", permissions: ["call:AddProposal", "transfer:AddProposal"], vote_policy: {} },
        ],
        default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
        proposal_bond: "0",
        proposal_period: "604800000000000",
        bounty_bond: "100000000000000000000000",
        bounty_forgiveness_period: "604800000000000",
      },
    },
    facts: {
      accountExists: { "designer.near": true, "mallory.near": true, "alcie.near": false, [USDT]: true, "token.demo.near": true },
      hasCode: { [USDT]: true, "token.demo.near": true },
      tokens: { [USDT]: { symbol: "USDt", decimals: 6 } },
      daoTokenBalance: { [USDT]: 20_000n * 10n ** 6n },
      intentsBalance: { "nep141:wrap.near": 2_000n * NEAR },
    },
  };
}

export interface Sample {
  slug: string;
  name: string;
  teaches: string;
  proposal: Proposal;
}

function prop(id: number, proposer: string, description: string, kind: ProposalKind, votes: Record<string, [number, number, number]> = {}): Proposal {
  return {
    id,
    proposer,
    description,
    kind,
    status: "InProgress",
    vote_counts: votes,
    votes: {},
    submission_time: String(BigInt(Date.now() - 3_600_000) * 1_000_000n),
  };
}

export const SAMPLES: Sample[] = [
  {
    slug: "clean-payment",
    name: "Normal payment",
    teaches: "A routine USDt payment whose text matches its payload. No warnings.",
    proposal: prop(
      101,
      "designer.near",
      "* Proposal Action: payment-transfer <br>* Title: Logo design, October <br>* Summary: 1,200 USDT for the new logo and brand kit",
      fc(USDT, [{ method: "ft_transfer", args: { receiver_id: "designer.near", amount: "1200000000" }, deposit: 1n }]),
    ),
  },
  {
    slug: "hidden-second-action",
    name: "Payment with a hidden second action",
    teaches: "Looks like a 1,200 USDt payment. Action #2 sends 15,000 USDt to someone else.",
    proposal: prop(
      102,
      "designer.near",
      "* Proposal Action: payment-transfer <br>* Title: Logo design, October <br>* Summary: 1,200 USDT for the new logo and brand kit",
      fc(USDT, [
        { method: "ft_transfer", args: { receiver_id: "designer.near", amount: "1200000000" }, deposit: 1n },
        { method: "ft_transfer", args: { receiver_id: "mallory.near", amount: "15000000000" }, deposit: 1n },
      ]),
      { Approvers: [1, 0, 0] },
    ),
  },
  {
    slug: "amount-mismatch",
    name: "Description says 500, payload sends 5,000",
    teaches: "The title promises one amount; the call moves ten times more.",
    proposal: prop(
      103,
      "designer.near",
      "Reimburse conference travel: 500 USDT",
      fc(USDT, [{ method: "ft_transfer", args: { receiver_id: "designer.near", amount: "5000000000" }, deposit: 1n }]),
    ),
  },
  {
    slug: "ownership-as-payroll",
    name: "Labelled payroll, hands over a contract",
    teaches: "Treasury apps file it under payments; it calls set_owner on the DAO's token.",
    proposal: prop(
      104,
      "mallory.near",
      "* Proposal Action: payment-transfer <br>* Title: November payroll",
      fc("token.demo.near", [{ method: "set_owner", args: { owner_id: "mallory.near" } }]),
    ),
  },
  {
    slug: "unknown-upgrade",
    name: "Upgrade to unknown code",
    teaches: "UpgradeSelf to a code hash the Sputnik factory never published.",
    proposal: prop(105, "bob.near", "Routine upgrade to latest Sputnik", { UpgradeSelf: { hash: "7Ux1Gq9pK3dT8zW2mVbR5cN4hY6sJfLaE1oQ2iX3uZ9" } }),
  },
  {
    slug: "single-signer-role",
    name: "New role that can spend alone",
    teaches: "Adds an \"ops\" role whose single member can approve transfers by themself.",
    proposal: prop(106, "bob.near", "Add ops role for faster payouts", {
      ChangePolicyAddOrUpdateRole: {
        role: { name: "ops", kind: { Group: ["bob.near"] }, permissions: ["transfer:AddProposal", "transfer:VoteApprove", "call:VoteApprove"], vote_policy: {} },
      },
    }),
  },
  {
    slug: "typo-recipient",
    name: "Typo in the recipient",
    teaches: "300 NEAR to alcie.near, an account that does not exist.",
    proposal: prop(107, "carol.near", "Pay alice for moderation, 300 NEAR", { Transfer: { token_id: "", receiver_id: "alcie.near", amount: String(300n * NEAR) } }),
  },
  {
    slug: "drain-to-another-chain",
    name: "Withdraw most of the treasury to another chain",
    teaches: "Moves 1,800 NEAR out via NEAR Intents to an Ethereum address.",
    proposal: prop(
      108,
      "bob.near",
      "Bridge treasury to Ethereum for market making",
      fc("intents.near", [
        {
          method: "ft_withdraw",
          args: { token: "wrap.near", receiver_id: "wrap.near", amount: String(1_800n * NEAR), memo: "WITHDRAW_TO:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
          deposit: 1n,
        },
      ]),
    ),
  },
];
