// Turns a raw Sputnik proposal into decoded calls and concrete effects:
// what leaves the treasury, to whom, through which contract.

import { b64decodeBytes } from "./rpc.ts";
import { variantOf } from "./policy.ts";
import type { ActionCall, Proposal } from "./types.ts";

export type DecodedArgs =
  | { kind: "empty" }
  | { kind: "json"; value: any }
  | { kind: "text"; value: string }
  | { kind: "binary"; hex: string; length: number };

export function decodeArgs(b64: string | undefined | null): DecodedArgs {
  if (!b64) return { kind: "empty" };
  let bytes: Uint8Array;
  try {
    bytes = b64decodeBytes(b64);
  } catch {
    return { kind: "text", value: b64 };
  }
  if (bytes.length === 0) return { kind: "empty" };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    // Printable text that is not JSON (rare) vs. binary (Borsh etc.).
    const printable = [...bytes].every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128);
    if (printable && !text.includes("�")) return { kind: "text", value: text };
    const hex = [...bytes.slice(0, 64)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { kind: "binary", hex, length: bytes.length };
  }
}

export type Asset =
  | { kind: "near" }
  | { kind: "ft"; contract: string }
  /** Balance held inside NEAR Intents (intents.near), e.g. "nep141:usdt.tether-token.near". */
  | { kind: "intents"; tokenId: string }
  | { kind: "nft"; contract: string; tokenId: string };

export function assetKey(a: Asset): string {
  switch (a.kind) {
    case "near":
      return "near";
    case "ft":
      return `ft:${a.contract}`;
    case "intents":
      return `intents:${a.tokenId}`;
    case "nft":
      return `nft:${a.contract}:${a.tokenId}`;
  }
}

/** The FT contract behind an asset, if it is a plain NEP-141 or a nep141: intents token. */
export function ftContractOf(a: Asset): string | null {
  if (a.kind === "ft") return a.contract;
  if (a.kind === "intents" && a.tokenId.startsWith("nep141:")) return a.tokenId.slice(7);
  return null;
}

export type Effect =
  | {
      type: "outflow";
      asset: Asset;
      amount: bigint;
      /** Final beneficiary as best we can tell (account, or external chain address). */
      to: string;
      /** Plain-language route, e.g. "ft_transfer on usdt.tether-token.near". */
      via: string;
      /** True when the funds leave NEAR to another chain. */
      crossChain?: boolean;
      actionIndex: number;
    }
  | { type: "stake"; pool: string; amount: bigint | "all"; direction: "stake" | "unstake" | "withdraw"; actionIndex: number }
  | { type: "wrap"; amount: bigint; direction: "wrap" | "unwrap"; actionIndex: number }
  | { type: "control"; target: string; method: string; detail: string; actionIndex: number }
  | { type: "storage"; target: string; amount: bigint; actionIndex: number };

export interface DecodedCall {
  index: number;
  receiver: string;
  method: string;
  args: DecodedArgs;
  deposit: bigint;
  gasTgas: number;
  /** True when X-Ray knows what this method does; false means "decoded but not understood". */
  known: boolean;
}

export interface Decoded {
  variant: string;
  calls: DecodedCall[];
  effects: Effect[];
}

export const KNOWN_CONTRACTS: Record<string, string> = {
  "wrap.near": "wNEAR token",
  "intents.near": "NEAR Intents",
  "usdt.tether-token.near": "USDt (Tether)",
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "USDC (native)",
  "v2.ref-finance.near": "Rhea (Ref) DEX",
  "contract.main.burrow.near": "Rhea Lending (Burrow)",
  "meta-pool.near": "Meta Pool liquid staking",
  "lockup.near": "Lockup factory",
  "bulkpayment.near": "Trezu bulk payments",
  "sputnik-dao.near": "Sputnik DAO factory",
  "social.near": "NEAR Social",
};

export function describeAccount(id: string): string | null {
  if (KNOWN_CONTRACTS[id]) return KNOWN_CONTRACTS[id];
  if (/\.(poolv1|pool|pool\.f863973\.m0)\.near$/.test(id)) return "staking pool";
  if (id.endsWith(".sputnik-dao.near")) return "Sputnik DAO";
  if (id.endsWith(".lockup.near")) return "lockup contract";
  if (id.endsWith(".omft.near")) return "bridged token (Intents)";
  return null;
}

export function isStakingPool(id: string): boolean {
  return /\.(poolv1|pool)\.near$/.test(id) || id.endsWith(".pool.f863973.m0");
}

/** Methods that hand control of another contract to someone. */
const CONTROL_METHODS = new Set([
  "set_owner",
  "set_owner_id",
  "change_owner",
  "transfer_ownership",
  "update_owner",
  "set_admin",
  "add_admin",
  "add_full_access_key",
  "add_guardian",
  "set_guardians",
  "grant_role",
  "acl_grant_role",
  "add_super_admin",
  "acl_add_super_admin",
  "acl_transfer_super_admin",
  "upgrade",
  "update_contract",
  "migrate",
  "deploy",
  "set_code",
  "pause",
  "unpause",
  "pa_pause_feature",
  "pa_unpause_feature",
  "set_contract_owner",
]);

function big(v: unknown): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  } catch {
    /* fallthrough */
  }
  return 0n;
}

function decodeCall(index: number, receiver: string, a: ActionCall): DecodedCall {
  return {
    index,
    receiver,
    method: a.method_name,
    args: decodeArgs(a.args),
    deposit: big(a.deposit),
    gasTgas: Number(big(String(a.gas))) / 1e12,
    known: KNOWN_METHODS.has(a.method_name) || CONTROL_METHODS.has(a.method_name),
  };
}

/** Methods whose effect X-Ray models (see callEffects). Anything else is reported as not understood. */
export const KNOWN_METHODS = new Set([
  "ft_transfer",
  "ft_transfer_call",
  "nft_transfer",
  "nft_transfer_call",
  "mt_transfer",
  "mt_transfer_call",
  "mt_batch_transfer",
  "mt_batch_transfer_call",
  "ft_withdraw",
  "mt_withdraw",
  "near_deposit",
  "near_withdraw",
  "storage_deposit",
  "deposit_and_stake",
  "deposit",
  "stake",
  "unstake",
  "unstake_all",
  "withdraw",
  "withdraw_all",
  "transfer",
]);

/** Effects of one function call made by the DAO. */
export function callEffects(daoId: string, c: DecodedCall): Effect[] {
  const out: Effect[] = [];
  const args = c.args.kind === "json" && c.args.value && typeof c.args.value === "object" ? c.args.value : {};
  const i = c.index;
  const m = c.method;

  // Attached NEAR. Small storage/1-yocto deposits are reported as storage, not outflow.
  // 1 yoctoNEAR is the NEP-141 "confirm with full-access key" deposit, not a payment.
  if (c.deposit > 1n) {
    if (c.receiver === "wrap.near" && m === "near_deposit") {
      out.push({ type: "wrap", amount: c.deposit, direction: "wrap", actionIndex: i });
    } else if (isStakingPool(c.receiver) && (m === "deposit_and_stake" || m === "deposit")) {
      out.push({ type: "stake", pool: c.receiver, amount: c.deposit, direction: "stake", actionIndex: i });
    } else if (m === "storage_deposit" || c.deposit <= 10n ** 22n /* 0.01 NEAR */) {
      out.push({ type: "storage", target: c.receiver, amount: c.deposit, actionIndex: i });
    } else {
      out.push({
        type: "outflow",
        asset: { kind: "near" },
        amount: c.deposit,
        to: c.receiver,
        via: `deposit attached to ${m} on ${nameOf(c.receiver)}`,
        actionIndex: i,
      });
    }
  }

  switch (m) {
    case "ft_transfer":
    case "ft_transfer_call": {
      const to = String(args.receiver_id ?? "?");
      let finalTo = to;
      let crossChain = false;
      let via = `${m} on ${nameOf(c.receiver)}`;
      if (m === "ft_transfer_call" && to === "intents.near") {
        // Deposit into the DAO's (or someone's) NEAR Intents balance.
        const msg = typeof args.msg === "string" ? args.msg : "";
        let parsed: any = null;
        try {
          parsed = msg ? JSON.parse(msg) : null;
        } catch {
          /* plain string msg is the beneficiary account id */
        }
        const beneficiary = parsed?.receiver_id ?? (msg && !parsed ? msg : daoId);
        finalTo = beneficiary || daoId;
        via = `deposit into NEAR Intents for ${finalTo}`;
      }
      if (finalTo === daoId) {
        // Moves DAO funds into a venue still controlled by the DAO; not an outflow.
        out.push({ type: "control", target: to, method: m, detail: `moves ${c.receiver} tokens to ${to} for the DAO itself`, actionIndex: i });
        break;
      }
      out.push({ type: "outflow", asset: { kind: "ft", contract: c.receiver }, amount: big(args.amount), to: finalTo, via, crossChain, actionIndex: i });
      break;
    }
    case "near_withdraw":
      if (c.receiver === "wrap.near") out.push({ type: "wrap", amount: big(args.amount), direction: "unwrap", actionIndex: i });
      break;
    case "nft_transfer":
    case "nft_transfer_call":
      out.push({
        type: "outflow",
        asset: { kind: "nft", contract: c.receiver, tokenId: String(args.token_id ?? "?") },
        amount: 1n,
        to: String(args.receiver_id ?? "?"),
        via: `${m} on ${nameOf(c.receiver)}`,
        actionIndex: i,
      });
      break;
    case "mt_transfer":
    case "mt_transfer_call": {
      out.push({
        type: "outflow",
        asset: c.receiver === "intents.near" ? { kind: "intents", tokenId: String(args.token_id ?? "?") } : { kind: "ft", contract: `${c.receiver}#${args.token_id}` },
        amount: big(args.amount),
        to: String(args.receiver_id ?? "?"),
        via: `${m} on ${nameOf(c.receiver)}`,
        actionIndex: i,
      });
      break;
    }
    case "mt_batch_transfer":
    case "mt_batch_transfer_call": {
      const ids: unknown[] = Array.isArray(args.token_ids) ? args.token_ids : [];
      const amounts: unknown[] = Array.isArray(args.amounts) ? args.amounts : [];
      ids.forEach((id, k) =>
        out.push({
          type: "outflow",
          asset: c.receiver === "intents.near" ? { kind: "intents", tokenId: String(id) } : { kind: "ft", contract: `${c.receiver}#${id}` },
          amount: big(amounts[k]),
          to: String(args.receiver_id ?? "?"),
          via: `${m} on ${nameOf(c.receiver)}`,
          actionIndex: i,
        }),
      );
      break;
    }
    case "ft_withdraw": {
      if (c.receiver !== "intents.near") break;
      const token = String(args.token ?? "?");
      const memo = typeof args.memo === "string" ? args.memo : "";
      const external = memo.startsWith("WITHDRAW_TO:");
      const to = external ? memo.slice("WITHDRAW_TO:".length) : String(args.receiver_id ?? "?");
      out.push({
        type: "outflow",
        asset: { kind: "intents", tokenId: token.startsWith("nep") ? token : `nep141:${token}` },
        amount: big(args.amount),
        to,
        via: external ? `NEAR Intents withdrawal through ${token} bridge` : `NEAR Intents withdrawal to ${to}`,
        crossChain: external,
        actionIndex: i,
      });
      break;
    }
    case "mt_withdraw": {
      if (c.receiver !== "intents.near") break;
      const ids: unknown[] = Array.isArray(args.token_ids) ? args.token_ids : [];
      const amounts: unknown[] = Array.isArray(args.amounts) ? args.amounts : [];
      const memo = typeof args.memo === "string" ? args.memo : "";
      const to = memo.startsWith("WITHDRAW_TO:") ? memo.slice(12) : String(args.receiver_id ?? "?");
      ids.forEach((id, k) =>
        out.push({
          type: "outflow",
          asset: { kind: "intents", tokenId: String(id).startsWith("nep245:") ? String(id) : `nep245:${args.token}:${id}` },
          amount: big(amounts[k]),
          to,
          via: "NEAR Intents multi-token withdrawal",
          crossChain: memo.startsWith("WITHDRAW_TO:"),
          actionIndex: i,
        }),
      );
      break;
    }
    case "transfer":
      // lockup contracts: transfer { amount, receiver_id }
      if (c.receiver.endsWith(".lockup.near") || c.receiver === "lockup.near") {
        out.push({ type: "outflow", asset: { kind: "near" }, amount: big(args.amount), to: String(args.receiver_id ?? "?"), via: `transfer out of lockup ${c.receiver}`, actionIndex: i });
      }
      break;
    case "unstake":
    case "unstake_all":
      if (isStakingPool(c.receiver)) out.push({ type: "stake", pool: c.receiver, amount: m === "unstake_all" ? "all" : big(args.amount), direction: "unstake", actionIndex: i });
      break;
    case "withdraw":
    case "withdraw_all":
      if (isStakingPool(c.receiver)) out.push({ type: "stake", pool: c.receiver, amount: m === "withdraw_all" ? "all" : big(args.amount), direction: "withdraw", actionIndex: i });
      break;
    default:
      if (CONTROL_METHODS.has(m)) {
        const who = args.owner_id ?? args.new_owner ?? args.new_owner_id ?? args.account_id ?? args.admin ?? args.public_key ?? "";
        out.push({ type: "control", target: c.receiver, method: m, detail: who ? `${m} → ${String(who)}` : m, actionIndex: i });
      }
  }
  return out;
}

export function decodeProposal(daoId: string, p: Proposal): Decoded {
  const variant = variantOf(p.kind);
  const calls: DecodedCall[] = [];
  const effects: Effect[] = [];
  const k = p.kind as any;
  switch (variant) {
    case "FunctionCall": {
      const fc = k.FunctionCall;
      (fc.actions as ActionCall[]).forEach((a, i) => {
        const c = decodeCall(i, fc.receiver_id, a);
        calls.push(c);
        effects.push(...callEffects(daoId, c));
      });
      break;
    }
    case "Transfer": {
      const t = k.Transfer;
      const tokenId: string = t.token_id ?? "";
      const asset: Asset = tokenId === "" || tokenId === "near" ? { kind: "near" } : { kind: "ft", contract: tokenId };
      effects.push({
        type: "outflow",
        asset,
        amount: big(t.amount),
        to: t.receiver_id,
        via: asset.kind === "near" ? "native NEAR transfer" : t.msg ? `ft_transfer_call on ${nameOf(tokenId)}` : `ft_transfer on ${nameOf(tokenId)}`,
        actionIndex: 0,
      });
      break;
    }
    case "AddBounty": {
      const b = k.AddBounty.bounty;
      const token: string = b.token ?? "";
      effects.push({
        type: "outflow",
        asset: token === "" ? { kind: "near" } : { kind: "ft", contract: token },
        amount: big(b.amount) * BigInt(b.times ?? 1),
        to: "bounty claimants",
        via: `bounty: ${b.times ?? 1} × payout`,
        actionIndex: 0,
      });
      break;
    }
    case "UpgradeRemote": {
      const u = k.UpgradeRemote;
      effects.push({ type: "control", target: u.receiver_id, method: u.method_name, detail: `deploys code ${u.hash} to ${u.receiver_id}`, actionIndex: 0 });
      break;
    }
  }
  return { variant, calls, effects };
}

// ---------- description ----------

export interface ParsedDescription {
  /** Trezu-style structured fields, keys lower-cased with spaces ("proposal action"). */
  fields: Record<string, string>;
  /** Free text with structured lines removed. */
  text: string;
}

export function parseDescription(description: string): ParsedDescription {
  const fields: Record<string, string> = {};
  const trimmed = description.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      for (const [key, v] of Object.entries(j)) fields[normKey(key)] = typeof v === "string" ? v : JSON.stringify(v);
      return { fields, text: String(j.title ?? j.description ?? j.summary ?? "") };
    } catch {
      /* not JSON */
    }
  }
  const rest: string[] = [];
  for (const raw of description.split(/<br\s*\/?>|\n/)) {
    const line = raw.trim();
    const m = /^\*\s+([^:]{1,40}):\s*(.*)$/.exec(line);
    if (m) fields[normKey(m[1])] = m[2].trim();
    else if (line) rest.push(line);
  }
  return { fields, text: rest.join("\n") };
}

function normKey(k: string): string {
  return k
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

/** Amounts written in the human text, e.g. "500 USDC", "1,250.5 NEAR", "$300". */
export function mentionedAmounts(text: string): { value: number; symbol: string }[] {
  const out: { value: number; symbol: string }[] = [];
  // Spaces only (no newlines): "Recipients: 3" followed by a "Contract: USDC.e" line is not "3 USDC".
  const re = /(?:\$[ \t]?(\d[\d,]*(?:\.\d+)?)(?:[ \t]?(k|K))?)|(\d[\d,]*(?:\.\d+)?)[ \t]?(k|K)?[ \t]?(NEAR|wNEAR|USDC|USDT|USDt|USD|DAI|ETH|BTC|Ⓝ)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) {
      const v = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
      out.push({ value: v, symbol: "USD" });
    } else {
      const v = Number(m[3].replace(/,/g, "")) * (m[4] ? 1000 : 1);
      let sym = m[5].toUpperCase();
      if (sym === "Ⓝ") sym = "NEAR";
      if (sym === "USDT") sym = "USDT";
      out.push({ value: v, symbol: sym });
    }
  }
  return out.filter((x) => Number.isFinite(x.value) && x.value > 0);
}

/** Readable name for a contract in prose: known label, or a shortened id. */
export function nameOf(id: string): string {
  const known = describeAccount(id);
  if (known && KNOWN_CONTRACTS[id]) return known;
  return id.length > 32 ? `${id.slice(0, 8)}…${id.slice(-14)}` : id;
}
