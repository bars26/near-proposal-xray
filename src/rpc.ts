// Minimal NEAR JSON-RPC client: view calls and account lookups.
// Public RPCs rate-limit hard (HTTP 429), so every call rotates endpoints,
// backs off and retries, and a small semaphore caps concurrency.

// Checked 2026-11-09: near.lava.build is discontinued (410), blockpi needs payment,
// rpc.mainnet.near.org is deprecated and rate-limited. FastNEAR signals rate limits
// with HTTP 200 + error.code -429, so both forms are treated as "try the next one".
export const DEFAULT_RPCS = [
  "https://near.drpc.org",
  "https://rpc.mainnet.fastnear.com",
  "https://archival-rpc.mainnet.near.org",
  "https://rpc.intea.rs",
];

/** Errors that are about the endpoint, not about the query: retry elsewhere. */
function isEndpointError(err: any): boolean {
  const code = err?.code;
  const msg = JSON.stringify(err ?? "");
  if (code === -429 || code === -32601 || code === 429) return true;
  if (err?.name === "HANDLER_ERROR" || err?.cause?.name) {
    // Real query errors (UNKNOWN_ACCOUNT, etc.) come with a cause; timeouts are retryable.
    return /TIMEOUT|NO_SYNCED_BLOCKS|NOT_SYNCED|UNAVAILABLE_SHARD|GARBAGE_COLLECTED/i.test(msg);
  }
  return /rate limit|discontinued|deprecated|Payment Required|Too Many/i.test(msg);
}

export class RpcError extends Error {}

export interface RpcOptions {
  endpoints?: string[];
  maxConcurrent?: number;
  retries?: number;
}

export class NearRpc {
  private endpoints: string[];
  private next = 0;
  private active = 0;
  private queue: (() => void)[] = [];
  private maxConcurrent: number;
  private retries: number;

  constructor(opts: RpcOptions = {}) {
    // archival-rpc.mainnet.near.org sends no CORS headers, so browsers skip it.
    const inBrowser = typeof window !== "undefined";
    this.endpoints = opts.endpoints?.length ? opts.endpoints : DEFAULT_RPCS.filter((u) => !(inBrowser && u.includes("archival-rpc")));
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.retries = opts.retries ?? 6;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((res) => this.queue.push(res));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  async raw(method: string, params: unknown): Promise<any> {
    return this.slot(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < this.retries; attempt++) {
        const url = this.endpoints[this.next++ % this.endpoints.length];
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: "xray", method, params }),
          });
          if (res.status === 429 || res.status === 410 || res.status === 402 || res.status >= 500) {
            lastErr = new RpcError(`${url} HTTP ${res.status}`);
            await sleep(300 * (attempt + 1));
            continue;
          }
          const body = await res.json();
          if (body.error) {
            if (isEndpointError(body.error)) {
              lastErr = new RpcError(`${url}: ${JSON.stringify(body.error).slice(0, 120)}`);
              await sleep(300 * (attempt + 1));
              continue;
            }
            throw new RpcError(JSON.stringify(body.error).slice(0, 300));
          }
          return body.result;
        } catch (e) {
          if (e instanceof RpcError) throw e;
          lastErr = e;
          await sleep(400 * (attempt + 1));
        }
      }
      throw lastErr instanceof Error ? lastErr : new RpcError(String(lastErr));
    });
  }

  /** Calls a view method. Returns undefined when the contract or method does not exist. */
  async view<T = unknown>(accountId: string, method: string, args: object = {}): Promise<T | undefined> {
    let result: any;
    try {
      result = await this.raw("query", {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: b64encode(JSON.stringify(args)),
      });
    } catch (e) {
      const msg = String((e as Error).message);
      if (/UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound|NO_CONTRACT_CODE|does not exist/i.test(msg)) {
        return undefined;
      }
      throw e;
    }
    if (result?.error) {
      if (/MethodNotFound|CodeDoesNotExist|does not exist/i.test(result.error)) return undefined;
      throw new RpcError(String(result.error).slice(0, 300));
    }
    const bytes = new Uint8Array(result.result as number[]);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  /** Returns account state, or null if the account does not exist. */
  async account(accountId: string): Promise<AccountView | null> {
    try {
      return await this.raw("query", {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      });
    } catch (e) {
      if (/UNKNOWN_ACCOUNT|does not exist/i.test(String((e as Error).message))) return null;
      throw e;
    }
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decodeBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Account that holds no code reports this hash. */
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export interface AccountView {
  amount: string;
  /** "1111…" when the account has no own code, including accounts that use a global contract. */
  code_hash: string;
  /** NEP-591 global contract referenced by hash (e.g. Sputnik v3.2 DAOs). */
  global_contract_hash?: string;
  /** NEP-591 global contract referenced by deployer account. */
  global_contract_account_id?: string;
}

/** True when the account runs any contract: its own code or a global contract. */
export function runsContract(a: AccountView): boolean {
  return a.code_hash !== EMPTY_CODE_HASH || !!a.global_contract_hash || !!a.global_contract_account_id;
}

/** Hash of the code the account runs, or undefined when it has none or it cannot be pinned to a hash. */
export function effectiveCodeHash(a: AccountView): string | undefined {
  if (a.global_contract_hash) return a.global_contract_hash;
  if (a.global_contract_account_id) return undefined; // follows whatever that account publishes
  return a.code_hash !== EMPTY_CODE_HASH ? a.code_hash : undefined;
}
