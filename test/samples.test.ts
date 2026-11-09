import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.ts";
import { SAMPLES, demoContext } from "../src/samples.ts";

// The README promises these exact outcomes for the in-app samples.
const EXPECT: Record<string, { worst: string | null; has: string[] }> = {
  "clean-payment": { worst: "info", has: ["outsider"] },
  "hidden-second-action": { worst: "critical", has: ["hidden-action", "treasury-share"] },
  "amount-mismatch": { worst: "high", has: ["description-mismatch"] },
  "ownership-as-payroll": { worst: "critical", has: ["control-change", "label-mismatch"] },
  "unknown-upgrade": { worst: "critical", has: ["upgrade-unknown"] },
  "single-signer-role": { worst: "critical", has: ["single-signer"] },
  "typo-recipient": { worst: "high", has: ["recipient-missing"] },
  "drain-to-another-chain": { worst: "critical", has: ["treasury-share", "cross-chain"] },
};

describe("in-app samples", () => {
  const { ctx, facts, now } = demoContext();
  for (const s of SAMPLES) {
    it(`${s.slug} → ${EXPECT[s.slug].has.join(", ")}`, () => {
      const r = analyze(s.proposal, ctx, facts, now);
      expect(r.worst).toBe(EXPECT[s.slug].worst);
      expect(r.flags.map((f) => f.id)).toEqual(expect.arrayContaining(EXPECT[s.slug].has));
    });
  }
  it("the clean payment raises nothing above info and leaves nothing unchecked", () => {
    const r = analyze(SAMPLES[0].proposal, ctx, facts, now);
    expect(r.flags.filter((f) => f.severity !== "info")).toEqual([]);
    expect(r.unchecked).toEqual([]);
  });
});
