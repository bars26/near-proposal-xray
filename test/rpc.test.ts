import { describe, expect, it } from "vitest";
import { EMPTY_CODE_HASH, effectiveCodeHash, runsContract } from "../src/rpc.ts";

// Real view_account shape of deer.sputnik-dao.near (2026-11-09): no own code, Sputnik v3.2 as a global contract.
const globalByHash = { amount: "1", code_hash: EMPTY_CODE_HASH, global_contract_hash: "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF" };

describe("global contracts (NEP-591)", () => {
  it("an account using a global contract by hash runs that code", () => {
    expect(runsContract(globalByHash)).toBe(true);
    expect(effectiveCodeHash(globalByHash)).toBe("DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF");
  });
  it("by deployer account: runs code, but no pinned hash", () => {
    const a = { amount: "1", code_hash: EMPTY_CODE_HASH, global_contract_account_id: "deployer.near" };
    expect(runsContract(a)).toBe(true);
    expect(effectiveCodeHash(a)).toBeUndefined();
  });
  it("own code and no code", () => {
    expect(effectiveCodeHash({ amount: "1", code_hash: "2Zof1Tyy4pMeJM48mDSi5ww2QQhTz97b9S8h6W6r4HnK" })).toBe("2Zof1Tyy4pMeJM48mDSi5ww2QQhTz97b9S8h6W6r4HnK");
    expect(runsContract({ amount: "1", code_hash: EMPTY_CODE_HASH })).toBe(false);
  });
});
