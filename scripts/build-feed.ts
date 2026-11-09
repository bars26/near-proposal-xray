// Builds public/feed.json: every recent proposal across all Sputnik DAOs (incl. Trezu
// treasuries), X-rayed and ranked by risk. Run by GitHub Actions on a schedule.
//
//   npm run feed                       # full scan
//   npm run feed -- --days 30 --per-dao 20
//   npm run feed -- --calibrate        # also print how often each rule fires
//   npm run feed -- --out out          # write feed.json + feed-state.json elsewhere (CI)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { NearRpc } from "../src/rpc.ts";
import { FACTORY, collectFacts, loadDao } from "../src/chain.ts";
import { analyze, SEVERITY_ORDER, type Report } from "../src/analyze.ts";
import type { Proposal } from "../src/types.ts";

const argv = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
};
const DAYS = opt("days", 90);
const PER_DAO = opt("per-dao", 25);
const CALIBRATE = argv.includes("--calibrate");
const outIdx = argv.indexOf("--out");
const OUT_DIR = outIdx >= 0 ? argv[outIdx + 1] : "public";
const OUT = `${OUT_DIR}/feed.json`;
const STATE = `${OUT_DIR}/feed-state.json`;

const rpc = new NearRpc({ maxConcurrent: 6, retries: 8 });
const now = Date.now();
const cutoffNs = BigInt(now - DAYS * 86_400_000) * 1_000_000n;

type State = Record<string, { last: number; lastTimeNs: string }>;
const prev: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};

const daos = (await rpc.view<string[]>(FACTORY, "get_dao_list")) ?? [];
log(`factory lists ${daos.length} DAOs`);

// 1) last proposal id + time for every DAO (time only re-fetched when the id moved)
const state: State = {};
let done = 0;
await Promise.all(
  daos.map(async (dao) => {
    try {
      const last = (await rpc.view<number>(dao, "get_last_proposal_id")) ?? 0;
      if (last > 0) {
        const cached = prev[dao];
        let lastTimeNs = cached && cached.last === last ? cached.lastTimeNs : "0";
        if (lastTimeNs === "0") {
          const p = await rpc.view<Proposal>(dao, "get_proposal", { id: last - 1 });
          lastTimeNs = p?.submission_time ?? "0";
        }
        state[dao] = { last, lastTimeNs };
      }
    } catch (e) {
      if (prev[dao]) state[dao] = prev[dao];
    }
    if (++done % 250 === 0) log(`  scanned ${done}/${daos.length}`);
  }),
);
const active = Object.entries(state)
  .filter(([, s]) => BigInt(s.lastTimeNs) >= cutoffNs)
  .map(([d]) => d);
log(`${Object.keys(state).length} DAOs have proposals; ${active.length} active in the last ${DAYS} days`);

// 2) X-ray recent proposals of active DAOs
const reports: Report[] = [];
const failures: string[] = [];
for (const dao of active) {
  try {
    const ctx = await loadDao(rpc, dao);
    const last = state[dao].last;
    const from = Math.max(0, last - PER_DAO);
    const proposals = ((await rpc.view<Proposal[]>(dao, "get_proposals", { from_index: from, limit: last - from })) ?? []).filter(
      (p) => BigInt(p.submission_time) >= cutoffNs,
    );
    if (!proposals.length) continue;
    const facts = await collectFacts(rpc, ctx, proposals);
    for (const p of proposals) reports.push(analyze(p, ctx, facts, now));
  } catch (e) {
    failures.push(`${dao}: ${(e as Error).message.slice(0, 120)}`);
  }
}
log(`analysed ${reports.length} proposals (${failures.length} DAOs failed)`);

// 3) write feed: open proposals first, by severity, then newest
const rank = (r: Report) => (r.worst ? SEVERITY_ORDER.indexOf(r.worst) : 9);
reports.sort((a, b) => {
  const ao = a.status === "InProgress" ? 0 : 1;
  const bo = b.status === "InProgress" ? 0 : 1;
  return ao - bo || rank(a) - rank(b) || b.submittedAtMs - a.submittedAtMs;
});

const items = reports.map((r) => ({
  daoId: r.daoId,
  id: r.id,
  title: r.description.title.slice(0, 160),
  proposer: r.proposer,
  status: r.status,
  submittedAtMs: r.submittedAtMs,
  expiresAtMs: r.votes.expiresAtMs,
  remaining: r.votes.remaining,
  worst: r.worst,
  summary: r.summary.slice(0, 3),
  flags: r.flags.map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
}));

const counts: Record<string, number> = {};
// Per proposal, not per flag: one proposal can raise the same rule several times.
for (const r of reports) for (const id of new Set(r.flags.map((f) => f.id))) counts[id] = (counts[id] ?? 0) + 1;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date(now).toISOString(),
      windowDays: DAYS,
      factory: FACTORY,
      daoCount: daos.length,
      activeDaos: active.length,
      proposals: reports.length,
      open: reports.filter((r) => r.status === "InProgress").length,
      flagCounts: counts,
      items,
    },
    null,
    1,
  ),
);
writeFileSync(STATE, JSON.stringify(state));
log(`wrote ${OUT}`);

if (CALIBRATE) {
  console.log("\nrule frequency over", reports.length, "proposals:");
  for (const [id, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(22)} ${String(n).padStart(4)}  (${((n / reports.length) * 100).toFixed(1)}%)`);
  }
  const bySev: Record<string, number> = {};
  for (const r of reports) bySev[r.worst ?? "clean"] = (bySev[r.worst ?? "clean"] ?? 0) + 1;
  console.log("worst severity per proposal:", bySev);
  if (failures.length) console.log("failures:", failures.slice(0, 10));
}

function log(s: string) {
  console.error(`[feed] ${s}`);
}
