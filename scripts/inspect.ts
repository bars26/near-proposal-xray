// CLI: npm run inspect -- <dao.sputnik-dao.near> [proposalId] [--json] [--last N]
// Prints the X-Ray for one proposal, or for the last N proposals of a DAO.

import { NearRpc } from "../src/rpc.ts";
import { collectFacts, loadDao, loadProposal, loadProposals } from "../src/chain.ts";
import { analyze, type Report } from "../src/analyze.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const lastIdx = args.indexOf("--last");
const last = lastIdx >= 0 ? Number(args[lastIdx + 1]) : 10;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--last");
const [daoArg, idArg] = positional;
if (!daoArg) {
  console.error("usage: npm run inspect -- <dao-id> [proposal-id] [--last N] [--json]");
  process.exit(1);
}
const daoId = daoArg.includes(".") ? daoArg : `${daoArg}.sputnik-dao.near`;

const rpc = new NearRpc();
const ctx = await loadDao(rpc, daoId);
const proposals = idArg !== undefined ? [await loadProposal(rpc, daoId, Number(idArg))].filter((p) => !!p) : await loadProposals(rpc, daoId, last);
if (!proposals.length) {
  console.error("no proposals found");
  process.exit(1);
}
const facts = await collectFacts(rpc, ctx, proposals as any);
const reports = proposals.map((p) => analyze(p!, ctx, facts));

if (json) {
  console.log(JSON.stringify(reports, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
} else {
  for (const r of reports) print(r);
}

function print(r: Report) {
  const icon = { critical: "🟥", high: "🟧", medium: "🟨", info: "⬜" } as const;
  console.log(`\n#${r.id} [${r.status}] ${r.daoId} — by ${r.proposer}`);
  if (r.description.title) console.log(`  "${r.description.title.slice(0, 120)}"`);
  for (const s of r.summary) console.log(`  → ${s}`);
  for (const f of r.flags) console.log(`  ${icon[f.severity]} ${f.severity.toUpperCase()}: ${f.title} — ${f.detail}`);
  const v = r.votes;
  console.log(`  votes: ${v.paths.map((p) => `${p.role} ${p.approvals}/${p.needed ?? "token"}`).join(", ") || "no approval path"}${v.remaining !== null && r.status === "InProgress" ? ` (needs ${v.remaining} more)` : ""}`);
}
