// Fetches the DAO context and the on-chain facts a set of proposals depends on.

import { NearRpc, EMPTY_CODE_HASH } from "./rpc.ts";
import { decodeProposal, ftContractOf } from "./decode.ts";
import type { ChainFacts, DaoContext, Policy, Proposal } from "./types.ts";

export const FACTORY = "sputnik-dao.near";

export async function loadDao(rpc: NearRpc, daoId: string): Promise<DaoContext> {
  const [policy, account, metadata] = await Promise.all([
    rpc.view<Policy>(daoId, "get_policy"),
    rpc.account(daoId),
    factoryMetadata(rpc),
  ]);
  if (!account) throw new Error(`${daoId} does not exist on NEAR mainnet`);
  if (!policy) throw new Error(`${daoId} is not a Sputnik DAO (no get_policy)`);
  const versions: Record<string, string> = {};
  for (const [h, m] of metadata) versions[h] = `v${(m as any)?.version?.join(".") ?? "?"}`;
  return {
    daoId,
    policy,
    nearBalance: BigInt(account.amount),
    knownCodeHashes: metadata.map(([h]) => h),
    versions,
    codeHash: account.code_hash,
  };
}

let metadataCache: Promise<[string, unknown][]> | null = null;
/** Factory release list, fetched once per process/page. */
function factoryMetadata(rpc: NearRpc): Promise<[string, unknown][]> {
  metadataCache ??= rpc
    .view<[string, unknown][]>(FACTORY, "get_contracts_metadata")
    .then((m) => m ?? [])
    .catch(() => {
      metadataCache = null;
      return [];
    });
  return metadataCache;
}

export async function loadProposals(rpc: NearRpc, daoId: string, limit = 50): Promise<Proposal[]> {
  const last = (await rpc.view<number>(daoId, "get_last_proposal_id")) ?? 0;
  const out: Proposal[] = [];
  const page = 50;
  for (let from = Math.max(0, last - limit); from < last; from += page) {
    const chunk = (await rpc.view<Proposal[]>(daoId, "get_proposals", { from_index: from, limit: Math.min(page, last - from) })) ?? [];
    out.push(...chunk);
  }
  return out.sort((a, b) => b.id - a.id);
}

export async function loadProposal(rpc: NearRpc, daoId: string, id: number): Promise<Proposal | undefined> {
  return rpc.view<Proposal>(daoId, "get_proposal", { id });
}

/** Accounts and tokens referenced by these proposals, looked up in parallel. */
export async function collectFacts(rpc: NearRpc, ctx: DaoContext, proposals: Proposal[]): Promise<ChainFacts> {
  const accounts = new Set<string>();
  const tokens = new Set<string>();
  const intentsTokens = new Set<string>();
  for (const p of proposals) {
    const d = decodeProposal(ctx.daoId, p);
    for (const c of d.calls) accounts.add(c.receiver);
    for (const e of d.effects) {
      if (e.type === "outflow") {
        if (isNearAccountId(e.to)) accounts.add(e.to);
        const ft = ftContractOf(e.asset);
        if (ft) tokens.add(ft);
        if (e.asset.kind === "intents") intentsTokens.add(e.asset.tokenId);
      }
    }
  }
  const facts: ChainFacts = { accountExists: {}, hasCode: {}, tokens: {}, daoTokenBalance: {}, intentsBalance: {} };
  await Promise.all([
    ...[...intentsTokens].map(async (t) => {
      try {
        const bal = await rpc.view<string>("intents.near", "mt_balance_of", { account_id: ctx.daoId, token_id: t });
        facts.intentsBalance![t] = bal != null ? BigInt(bal) : null;
      } catch {
        /* unknown */
      }
    }),
    ...[...accounts].map(async (a) => {
      try {
        const acc = await rpc.account(a);
        facts.accountExists[a] = !!acc;
        facts.hasCode[a] = !!acc && acc.code_hash !== EMPTY_CODE_HASH;
      } catch {
        /* unknown: leave undefined so no rule fires on missing data */
      }
    }),
    ...[...tokens].map(async (t) => {
      try {
        const md = await rpc.view<{ symbol: string; decimals: number }>(t, "ft_metadata");
        facts.tokens[t] = md ? { symbol: md.symbol, decimals: md.decimals } : null;
        const bal = await rpc.view<string>(t, "ft_balance_of", { account_id: ctx.daoId });
        facts.daoTokenBalance[t] = bal != null ? BigInt(bal) : null;
      } catch {
        facts.tokens[t] = null;
      }
    }),
  ]);
  return facts;
}

/** NEAR account id grammar (named or implicit). */
export function isNearAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

/** Implicit accounts (64 hex / 0x+40 hex) come into existence when funded; named ones must exist already. */
export function isImplicit(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s) || /^0x[0-9a-f]{40}$/.test(s);
}
