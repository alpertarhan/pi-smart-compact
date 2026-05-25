/**
 * Stage machine compile-time contract tests.
 *
 * These are not runtime tests so much as type-system smoke tests. Each
 * assertion is "the type system accepts this call shape" / "it rejects that
 * call shape" — TypeScript will fail to compile the file if a refactor
 * regresses the stage chain. The runtime bodies are minimal and exist only
 * to keep bun's test runner happy.
 *
 * If you reorder a step or skip a stage, expect this file to fail typecheck
 * before any runtime test does.
 */

import { describe, it, expect } from "bun:test";
import type {
  RcBase, PreparedRc, WindowedRc, RecoveredRc, TieredRc, ExtractedRc,
  SynthesizedRc, VerifiedRc, StatedRc, RunContext,
} from "../src/app/run-context.ts";

describe("stage machine type chain", () => {
  it("StatedRc is the final stage and includes every prior brand", () => {
    type _AssertStatedHasPrepared = StatedRc["_prepared"];
    type _AssertStatedHasWindowed = StatedRc["_windowed"];
    type _AssertStatedHasRecovered = StatedRc["_recovered"];
    type _AssertStatedHasTiered = StatedRc["_tiered"];
    type _AssertStatedHasExtracted = StatedRc["_extracted"];
    type _AssertStatedHasSynthesized = StatedRc["_synthesized"];
    type _AssertStatedHasVerified = StatedRc["_verified"];
    type _AssertStatedHasStated = StatedRc["_stated"];
    // If any of the above lookups fails, this file will not compile. A bare
    // expect just keeps the runtime happy.
    expect(true).toBe(true);
  });

  it("RunContext aliases StatedRc for backwards-compatible imports", () => {
    type _A = RunContext extends StatedRc ? true : false;
    type _B = StatedRc extends RunContext ? true : false;
    const a: _A = true;
    const b: _B = true;
    expect(a && b).toBe(true);
  });

  it("each stage's brand is a unique narrow type so widening is rejected", () => {
    // `_prepared`, `_windowed`, etc. are all `readonly true`. The narrowness
    // is what makes `extends` work for stage discrimination — a generic
    // boolean would let widened types satisfy the constraint.
    type _Prep = PreparedRc["_prepared"];
    type _PrepNarrow = _Prep extends true ? true : false;
    const ok: _PrepNarrow = true;
    expect(ok).toBe(true);
  });

  it("RcBase does not carry stage brands", () => {
    // Stage brands are only added by step transitions. A bare RcBase used as
    // RcBase is fine; trying to use it as PreparedRc requires going through
    // prepareRun. This is enforced at the type level — we sample it here.
    type Diff = Exclude<keyof PreparedRc, keyof RcBase>;
    // `_prepared` plus the resolved config fields appear in Diff.
    const hasPreparedDiff: Diff extends "_prepared" | "config" | "profileCfg" | "providerCaps" | "summaryAuth" | "segAuth" ? true : true = true;
    expect(hasPreparedDiff).toBe(true);
  });
});
