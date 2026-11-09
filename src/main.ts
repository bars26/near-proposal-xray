import "./style.css";
import { NearRpc } from "./rpc.ts";
import { collectFacts, loadDao, loadProposal, loadProposals } from "./chain.ts";
import { analyze, verdictOf, type Report, type Severity } from "./analyze.ts";
import { daoHealth } from "./dao.ts";
import { describeAccount, type DecodedCall } from "./decode.ts";
import { durationNs, formatUnits } from "./format.ts";
import { SAMPLES, demoContext, DEMO_DAO } from "./samples.ts";
import type { DaoContext } from "./types.ts";

const rpc = new NearRpc({ maxConcurrent: 4 });
const app = document.getElementById("app")!;
const FEED_URL = import.meta.env.VITE_FEED_URL ?? "https://raw.githubusercontent.com/bars26/near-proposal-xray/data/feed.json";

// ---------- helpers ----------

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SEV_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Check", info: "Note" };

type Verdict = Severity | "partial" | "clean";

/** Row badge: worst finding, else "Partly checked" when checks could not run, else "Clean". */
function verdictBadge(v: Verdict) {
  if (v === "partial") return `<span class="badge partial" title="No problem found, but some checks could not run">Partly checked</span>`;
  if (v === "clean") return `<span class="badge clean">Clean</span>`;
  return badge(v);
}

function badge(sev: Severity | null, text?: string) {
  if (!sev) return `<span class="badge clean">Clean</span>`;
  return `<span class="badge ${sev}">${esc(text ?? SEV_LABEL[sev])}</span>`;
}

function ago(ms: number) {
  const d = Date.now() - ms;
  const abs = Math.abs(d);
  const unit = abs >= 86_400_000 ? [86_400_000, "d"] : abs >= 3_600_000 ? [3_600_000, "h"] : [60_000, "m"];
  const n = Math.max(1, Math.round(abs / (unit[0] as number)));
  return d >= 0 ? `${n}${unit[1]} ago` : `in ${n}${unit[1]}`;
}

function acct(id: string) {
  const label = describeAccount(id);
  const short = id.length > 34 ? `${id.slice(0, 12)}…${id.slice(-10)}` : id;
  return `<a class="acct" href="https://nearblocks.io/address/${encodeURIComponent(id)}" target="_blank" rel="noopener" title="${esc(id)}">${esc(short)}</a>${label ? ` <span class="muted">(${esc(label)})</span>` : ""}`;
}

function json(v: unknown) {
  return esc(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}

function loading(text: string) {
  app.innerHTML = `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
}

function fail(e: unknown) {
  app.innerHTML = `<section class="card error"><h2>Could not load that</h2><p>${esc((e as Error)?.message ?? e)}</p><p><a href="#/">Back to the feed</a></p></section>`;
}

/** "marketing", "x.sputnik-dao.near", "x.sputnik-dao.near #12", or any URL containing a DAO id. */
export function parseQuery(q: string): { dao: string; id?: number } | null {
  q = q.trim();
  if (!q) return null;
  const m = /([a-z0-9][a-z0-9_-]*\.sputnik-dao\.near)/i.exec(q) ?? /^([a-z0-9][a-z0-9_-]*)(?=$|\s|#|\/)/i.exec(q);
  if (!m) return null;
  let dao = m[1].toLowerCase();
  if (!dao.endsWith(".sputnik-dao.near")) dao += ".sputnik-dao.near";
  const idm = /(?:#|proposals?\/|[?&]id=|\s)(\d+)\s*$/.exec(q);
  return { dao, id: idm ? Number(idm[1]) : undefined };
}

// ---------- routing ----------

// Each navigation gets a ticket; a slow load from an earlier page must not paint over a newer one.
let ticket = 0;
const render = (html: string, mine: number) => {
  if (mine === ticket) app.innerHTML = html;
  return mine === ticket;
};

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  const mine = ++ticket;
  try {
    if (parts[0] === "dao" && parts[1] && parts[2] !== undefined) return await showProposal(parts[1], Number(parts[2]), mine);
    if (parts[0] === "dao" && parts[1]) return await showDao(parts[1], mine);
    if (parts[0] === "sample" && parts[1]) return showSample(parts[1], mine);
    return await showHome(mine);
  } catch (e) {
    if (mine === ticket) fail(e);
  }
}


document.getElementById("search")!.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = (document.getElementById("q") as HTMLInputElement).value;
  const parsed = parseQuery(q);
  if (!parsed) return;
  location.hash = parsed.id !== undefined ? `#/dao/${parsed.dao}/${parsed.id}` : `#/dao/${parsed.dao}`;
});

// ---------- home: live feed ----------

interface FeedItem {
  daoId: string;
  id: number;
  title: string;
  proposer: string;
  status: string;
  submittedAtMs: number;
  expiresAtMs: number;
  remaining: number | null;
  worst: Severity | null;
  /** Present in feeds built after the "partly checked" change. */
  verdict?: Verdict;
  unchecked?: number;
  summary: string[];
  flags: { id: string; severity: Severity; title: string }[];
}
interface Feed {
  generatedAt: string;
  windowDays: number;
  daoCount: number;
  activeDaos: number;
  proposals: number;
  open: number;
  flagCounts: Record<string, number>;
  items: FeedItem[];
}

let feedFilter: "open" | "risky" | "all" = "risky";

async function showHome(mine: number) {
  loading("Loading the latest proposals across every Sputnik DAO…");
  let feed: Feed | null = null;
  // Live feed is republished hourly to the repo's `data` branch; the bundled snapshot is the fallback.
  for (const url of [FEED_URL, "/feed.json"]) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (res.ok) {
        feed = await res.json();
        break;
      }
    } catch {
      /* try the next source */
    }
  }
  if (!render(`
    <section class="hero">
      <h1>See what a DAO proposal <em>actually</em> does before you vote.</h1>
      <p>Sputnik DAO and Trezu treasuries approve function calls that most voters cannot read. X-Ray decodes every action, checks it against the description, the treasury and the voting rules, and flags what does not add up.</p>
    </section>
    <section class="card">
      <h2>Try a crafted proposal</h2>
      <p class="muted">Each one runs against a demo treasury (2,000 NEAR, 20,000 USDt, 3 approvers, 2 needed). Nothing touches the chain.</p>
      <div class="samples">${SAMPLES.map((s) => `<a class="sample" href="#/sample/${s.slug}"><b>${esc(s.name)}</b><span>${esc(s.teaches)}</span></a>`).join("")}</div>
    </section>
    <section class="card" id="feed">${feed ? feedHtml(feed) : `<h2>Live feed</h2><p class="muted">The feed could not be loaded. Search any DAO above, or build it locally with <code>npm run feed</code>.</p>`}</section>`, mine)) return;
  if (feed) wireFeed(feed);
}

function feedHtml(feed: Feed) {
  const items = feed.items.filter((i) =>
    feedFilter === "open" ? i.status === "InProgress" : feedFilter === "risky" ? i.worst === "critical" || i.worst === "high" : true,
  );
  return `
    <div class="feed-head">
      <div>
        <h2>Live feed</h2>
        <p class="muted">${feed.proposals.toLocaleString()} proposals from ${feed.activeDaos} active DAOs (of ${feed.daoCount.toLocaleString()}) in the last ${feed.windowDays} days · ${feed.open} open · updated ${ago(Date.parse(feed.generatedAt))}</p>
      </div>
      <div class="tabs" role="tablist">
        ${(["risky", "open", "all"] as const)
          .map((f) => `<button role="tab" data-f="${f}" aria-selected="${feedFilter === f}">${f === "risky" ? "High risk" : f === "open" ? "Open now" : "All"}</button>`)
          .join("")}
      </div>
    </div>
    <ul class="rows">${items.slice(0, 120).map(feedRow).join("") || `<li class="muted pad">Nothing here right now.</li>`}</ul>
    ${items.length > 120 ? `<p class="muted">Showing 120 of ${items.length}.</p>` : ""}`;
}

function feedRow(i: FeedItem) {
  const dao = i.daoId.replace(".sputnik-dao.near", "");
  const top = i.flags.filter((f) => f.severity !== "info").slice(0, 2);
  const open = i.status === "InProgress";
  return `<li><a class="row" href="#/dao/${i.daoId}/${i.id}">
    ${verdictBadge(i.verdict ?? i.worst ?? "clean")}
    <div class="row-main">
      <div class="row-title"><span class="dao">${esc(dao)}</span> <span class="muted">#${i.id}</span> ${esc(i.title || i.summary[0] || "")}</div>
      <div class="row-sub">${top.map((f) => `<span class="dot ${f.severity}"></span>${esc(f.title)}`).join(" &nbsp; ") || esc(i.summary[0] ?? "")}</div>
    </div>
    <div class="row-meta">${open ? `<span class="pill live">open${i.remaining !== null ? ` · ${i.remaining} vote${i.remaining === 1 ? "" : "s"} left` : ""}</span>` : `<span class="pill">${esc(i.status)}</span>`}<span class="muted">${ago(i.submittedAtMs)}</span></div>
  </a></li>`;
}

function wireFeed(feed: Feed) {
  document.querySelectorAll<HTMLButtonElement>("#feed [data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      feedFilter = b.dataset.f as typeof feedFilter;
      document.getElementById("feed")!.innerHTML = feedHtml(feed);
      wireFeed(feed);
    }),
  );
}

// ---------- DAO page ----------

async function showDao(daoId: string, mine: number) {
  loading(`Reading ${daoId} from NEAR mainnet…`);
  const ctx = await loadDao(rpc, daoId);
  const proposals = await loadProposals(rpc, daoId, 40);
  const facts = await collectFacts(rpc, ctx, proposals);
  const reports = proposals.map((p) => analyze(p, ctx, facts));
  reports.sort((a, b) => Number(b.status === "InProgress") - Number(a.status === "InProgress") || b.id - a.id);
  render(`
    ${daoHeader(ctx)}
    <section class="card">
      <h2>Recent proposals</h2>
      <ul class="rows">${reports
        .map(
          (r) => `<li><a class="row" href="#/dao/${daoId}/${r.id}">${verdictBadge(verdictOf(r))}
          <div class="row-main"><div class="row-title"><span class="muted">#${r.id}</span> ${esc(r.description.title || r.summary[0])}</div>
          <div class="row-sub">${esc(r.summary[0] ?? "")}</div></div>
          <div class="row-meta">${r.status === "InProgress" ? `<span class="pill live">open</span>` : `<span class="pill">${esc(r.status)}</span>`}<span class="muted">${ago(r.submittedAtMs)}</span></div></a></li>`,
        )
        .join("") || `<li class="muted pad">No proposals yet.</li>`}</ul>
    </section>`, mine);
}

function daoHeader(ctx: DaoContext, demo = false) {
  const h = daoHealth(ctx);
  return `
    <section class="card dao-head">
      <div class="dao-title">
        <div>
          <p class="eyebrow">${demo ? "Demo treasury (not on chain)" : "Sputnik DAO"}</p>
          <h1>${demo ? esc(ctx.daoId) : `<a href="#/dao/${ctx.daoId}">${esc(ctx.daoId)}</a>`}</h1>
        </div>
        <dl class="facts">
          <div><dt>Liquid NEAR</dt><dd>${formatUnits(ctx.nearBalance, 24, 2)}</dd></div>
          <div><dt>Members</dt><dd>${h.members}</dd></div>
          <div><dt>Contract</dt><dd>${h.version ? esc(h.version) : h.codeKnown === false ? `<span class="t-high">unknown code</span>` : "?"}</dd></div>
          <div><dt>Voting window</dt><dd>${durationNs(BigInt(ctx.policy.proposal_period))}</dd></div>
        </dl>
      </div>
      <h3>Approvals needed to…</h3>
      <div class="signers">${h.signers
        .map((s) => `<div class="signer ${s.n === 1 ? "one" : ""}"><b>${s.n ?? "–"}</b><span>${esc(s.text)}</span></div>`)
        .join("")}</div>
      ${h.notes.length ? `<ul class="notes">${h.notes.map((n) => `<li>${badge(n.severity)} ${esc(n.text)}</li>`).join("")}</ul>` : ""}
    </section>`;
}

// ---------- proposal page ----------

async function showProposal(daoId: string, id: number, mine: number) {
  loading(`X-raying ${daoId} #${id}…`);
  const [ctx, p] = await Promise.all([loadDao(rpc, daoId), loadProposal(rpc, daoId, id)]);
  if (!p) throw new Error(`${daoId} has no proposal #${id}`);
  const facts = await collectFacts(rpc, ctx, [p]);
  const r = analyze(p, ctx, facts);
  if (render(reportHtml(r, ctx, p, false), mine)) wireReport();
}

function showSample(slug: string, mine: number) {
  const s = SAMPLES.find((x) => x.slug === slug);
  if (!s) throw new Error(`No sample called ${slug}`);
  const { ctx, facts, now } = demoContext();
  const r = analyze(s.proposal, ctx, facts, now);
  render(`<p class="crumb"><a href="#/">← All samples</a> · ${esc(s.teaches)}</p>` + reportHtml(r, ctx, s.proposal, true), mine);
  wireReport();
}

function reportHtml(r: Report, ctx: DaoContext, raw: unknown, demo: boolean) {
  const titleLink = demo ? esc(DEMO_DAO) : `<a href="#/dao/${r.daoId}">${esc(r.daoId)}</a>`;
  const claims = Object.entries(r.description.fields);
  return `
    <section class="card verdict ${verdictOf(r)}">
      <p class="eyebrow">${titleLink} · proposal #${r.id} · ${esc(r.status)} · by ${acct(r.proposer)}</p>
      <h1>${esc(r.description.title || "Untitled proposal")}</h1>
      <div class="verdict-line">${
        verdictOf(r) === "partial"
          ? `<span class="badge partial">Partly checked</span>`
          : badge(r.worst, r.worst ? (r.worst === "info" ? "No risk found" : `${SEV_LABEL[r.worst]} risk`) : "No risk found")
      }
        <span>${r.flags.filter((f) => f.severity !== "info").length} warning(s) · ${r.decoded.calls.length || 1} action(s)</span></div>
    </section>

    <section class="grid2">
      <div class="card">
        <h2>What it says</h2>
        ${claims.length ? `<dl class="kv">${claims.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
        <p class="desc">${esc(r.description.raw.replace(/<br\s*\/?>/g, "\n").replace(/^\*\s+[^:\n]{1,40}:.*$/gm, "").trim() || (claims.length ? "" : "(no description)"))}</p>
      </div>
      <div class="card">
        <h2>What it does</h2>
        <ol class="does">${r.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      </div>
    </section>

    ${
      r.flags.length
        ? `<section class="card"><h2>Findings</h2><ul class="flags">${r.flags
            .map((f) => `<li class="flag ${f.severity}">${badge(f.severity)}<div><b>${esc(f.title)}</b><p>${esc(f.detail)}</p></div></li>`)
            .join("")}</ul></section>`
        : ""
    }

    ${
      r.unchecked.length
        ? `<section class="card unchecked"><h2>Not checked</h2><p class="muted">X-Ray could not run these checks, so "no warning" here does not mean safe.</p><ul class="plain">${r.unchecked
            .map((u) => `<li>${esc(u)}</li>`)
            .join("")}</ul></section>`
        : ""
    }

    <section class="grid2">
      <div class="card">
        <h2>Votes</h2>
        ${voteHtml(r)}
      </div>
      ${r.policyDiff ? `<div class="card"><h2>Policy change</h2>${policyHtml(r)}</div>` : `<div class="card"><h2>Rules today</h2>${miniRules(ctx)}</div>`}
    </section>

    ${
      r.decoded.calls.length
        ? `<section class="card"><h2>Every call, decoded</h2>${r.decoded.calls.map((c) => callHtml(c, r.decoded.calls.length)).join("")}</section>`
        : ""
    }

    <section class="card"><details><summary>Raw proposal JSON</summary><pre>${json(raw)}</pre></details></section>`;
}

function voteHtml(r: Report) {
  const v = r.votes;
  if (!v.paths.length) return `<p class="muted">No role can approve "${esc(v.label)}" proposals under the current policy.</p>`;
  const rows = v.paths
    .map((p) => {
      if (p.weighting === "token") return `<li><b>${esc(p.role)}</b> <span class="muted">token-weighted vote</span></li>`;
      const pct = p.needed ? Math.min(100, (p.approvals / p.needed) * 100) : 0;
      return `<li><div class="vote-line"><b>${esc(p.role)}</b><span>${p.approvals} of ${p.needed} approvals · ${p.members} member(s)</span></div><div class="bar"><i style="width:${pct}%"></i></div></li>`;
    })
    .join("");
  const when =
    r.status === "InProgress"
      ? `<p class="muted">Expires ${ago(v.expiresAtMs)} (${new Date(v.expiresAtMs).toUTCString().slice(5, 22)} UTC).${v.remaining !== null ? ` Needs <b>${v.remaining}</b> more approval${v.remaining === 1 ? "" : "s"}.` : ""}</p>`
      : "";
  return `<ul class="votes">${rows}</ul>${when}`;
}

function policyHtml(r: Report) {
  const d = r.policyDiff!;
  const lines = d.lines
    .filter((l) => (l.before?.n ?? null) !== (l.after?.n ?? null))
    .map((l) => `<tr><td>${esc(l.label)}</td><td>${l.before?.n ?? "–"}</td><td class="${(l.after?.n ?? 99) < (l.before?.n ?? 99) ? "t-high" : ""}">${l.after?.n ?? "–"}</td></tr>`)
    .join("");
  return `
    ${lines ? `<table class="diff"><thead><tr><th>Approvals to pass</th><th>Now</th><th>After</th></tr></thead><tbody>${lines}</tbody></table>` : `<p class="muted">Approval thresholds do not change.</p>`}
    <ul class="plain">
      ${d.addedMembers.map((m) => `<li>+ ${acct(m)}</li>`).join("")}
      ${d.removedMembers.map((m) => `<li>− ${acct(m)}</li>`).join("")}
      ${d.roleChanges.map((c) => `<li>${esc(c)}</li>`).join("")}
      ${d.periodAfter !== d.periodBefore ? `<li>Voting window: ${durationNs(d.periodBefore)} → ${durationNs(d.periodAfter)}</li>` : ""}
    </ul>`;
}

function miniRules(ctx: DaoContext) {
  const h = daoHealth(ctx);
  return `<div class="signers small">${h.signers.map((s) => `<div class="signer ${s.n === 1 ? "one" : ""}"><b>${s.n ?? "–"}</b><span>${esc(s.text)}</span></div>`).join("")}</div>`;
}

function callHtml(c: DecodedCall, total: number) {
  const args =
    c.args.kind === "json"
      ? `<pre>${json(c.args.value)}</pre>`
      : c.args.kind === "empty"
        ? `<p class="muted">No arguments.</p>`
        : c.args.kind === "text"
          ? `<pre>${esc(c.args.value)}</pre>`
          : `<p class="t-high">${c.args.length} bytes of binary data (not JSON). First bytes: <code>${esc(c.args.hex)}</code></p>`;
  return `<div class="call">
    <div class="call-head"><span class="pill">${c.index + 1} / ${total}</span> <code>${esc(c.method)}</code> on ${acct(c.receiver)}</div>
    <div class="call-meta muted">deposit ${c.deposit === 1n ? "1 yocto (security)" : `${formatUnits(c.deposit, 24)} NEAR`} · gas ${c.gasTgas} Tgas</div>
    ${args}
  </div>`;
}

function wireReport() {
  /* details/summary is native; nothing to wire yet */
}

// ---------- theme ----------

const root = document.documentElement;
try {
  const saved = localStorage.getItem("xray-theme");
  if (saved === "dark" || saved === "light") root.dataset.theme = saved;
} catch {
  /* storage blocked */
}
document.getElementById("theme")!.addEventListener("click", () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("xray-theme", root.dataset.theme);
  } catch {
    /* ignore */
  }
});

window.addEventListener("hashchange", route);
route();
