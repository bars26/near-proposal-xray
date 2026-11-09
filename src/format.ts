import type { Asset } from "./decode.ts";
import type { ChainFacts } from "./types.ts";
import { ftContractOf } from "./decode.ts";

export const NEAR_DECIMALS = 24;

export function formatUnits(v: bigint, decimals: number, maxFrac = 4): string {
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  if (whole === 0n && frac === "" && v > 0n) {
    // Tiny amount: show significant digits instead of 0.
    const full = (v % base).toString().padStart(decimals, "0");
    const firstNonZero = full.search(/[1-9]/);
    frac = full.slice(0, firstNonZero + 2).replace(/0+$/, "");
  }
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${w}${frac ? "." + frac : ""}`;
}

export function toNumber(v: bigint, decimals: number): number {
  return Number(formatUnits(v, decimals, 6).replace(/,/g, ""));
}

export interface AssetInfo {
  symbol: string;
  decimals: number | null;
}

export function assetInfo(a: Asset, facts: ChainFacts): AssetInfo {
  if (a.kind === "near") return { symbol: "NEAR", decimals: NEAR_DECIMALS };
  if (a.kind === "nft") return { symbol: `NFT ${a.tokenId}`, decimals: 0 };
  const ft = ftContractOf(a);
  if (ft === "wrap.near") return { symbol: "wNEAR", decimals: NEAR_DECIMALS };
  if (ft && facts.tokens[ft]) return { symbol: facts.tokens[ft]!.symbol, decimals: facts.tokens[ft]!.decimals };
  const label = a.kind === "intents" ? a.tokenId : a.contract;
  return { symbol: label.length > 28 ? label.slice(0, 12) + "…" + label.slice(-8) : label, decimals: null };
}

export function formatAmount(amount: bigint, a: Asset, facts: ChainFacts): string {
  const info = assetInfo(a, facts);
  if (a.kind === "nft") return info.symbol;
  if (info.decimals === null) return `${amount.toString()} (raw) ${info.symbol}`;
  return `${formatUnits(amount, info.decimals)} ${info.symbol}`;
}

export function shortAccount(id: string): string {
  return id.length > 30 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id;
}

export function durationNs(ns: bigint): string {
  const s = Number(ns / 1_000_000_000n);
  if (s >= 86400) return `${+(s / 86400).toFixed(1)} days`;
  if (s >= 3600) return `${+(s / 3600).toFixed(1)} hours`;
  if (s >= 60) return `${Math.round(s / 60)} minutes`;
  return `${s} seconds`;
}
