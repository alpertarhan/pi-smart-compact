/**
 * Human-origin provenance for constraints: a rule the user actually typed
 * keeps that origin across compactions, so a custom message repeating it
 * after the authoring turn left the window cannot make the carried-fact
 * filter drop it. Only raw human mining mints the origin; summaries, custom
 * and peer quotes, and forged text never promote themselves. Release and
 * supersession overrides stay effective: origin is not an immortal pin.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contextMessageEntries } from "../src/infra/ai-messages.ts";
import { recoverSourceMessages } from "../src/app/steps/recover.ts";
import { loadExtractionContinuity, selectCachedExtraction } from "../src/app/steps/extract.ts";
import { extractStructured, mineConstraints } from "../src/utils/extraction.ts";
import { mergeExtractions } from "../src/utils/cache.ts";
import {
  buildCompactionState, mergeCompactionStates, previewMergedContinuity, retireSupersededConstraints, saveCompactionState, upsertContinuityOverride,
} from "../src/utils/state.ts";
import { assembleFallback } from "../src/phases/synthesize.ts";
import { verifySummary } from "../src/phases/verify.ts";
import { buildEntryIdFingerprint, hashMessages } from "../src/utils/id-fingerprint.ts";
import { SecretScrubber } from "../src/domain/scrub.ts";
import { deriveProjectIdFromCwd } from "../src/utils/fingerprint.ts";
import { EXTRACTION_LIMITS, PROFILES, VERSION } from "../src/constants.ts";
import { normalizeFactKey } from "../src/utils/helpers.ts";
import type { CompactionState, ContinuityOverride, LlmMessage, OpenLoop, StructuredExtraction } from "../src/types.ts";

const RULE = "Never force-push the shared release branch.";
const RELEASED_RULE = "Do not push or open a PR yet; I want to test slice 2 locally first.";
const RELEASE = "ok push it now";const GOAL = "Ship the billing worker migration.";
const DUP_TYPE = "i-have-adhd-rules"; // non-quoting custom type

function user(text: string, customType?: string, timestamp?: number): LlmMessage {
  return { role: "user", content: text, ...(customType ? { customType } : {}), ...(timestamp !== undefined ? { timestamp } : {}) } as LlmMessage;
}

function carriedSummary(constraintLine: string): LlmMessage {
  return user(
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\n"
      + GOAL + "\n\n## Constraints & Preferences\n- " + constraintLine + "\n</summary>",
  );
}

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [], mediaAttachments: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 0,
    ...partial,
  };
}

/** A saved CompactionState shaped like the state step writes it. */
function savedState(overrides: Partial<CompactionState> = {}): CompactionState {
  return {
    goal: GOAL, decisions: [], constraints: [], modifiedFiles: [], readFiles: [],
    deletedFiles: [], unresolvedErrors: [], resolvedErrors: [], openLoops: [],
    topics: [], nextActions: [], criticalContext: [], sessionType: "implementation",
    compactionVersion: "test", updatedAt: Date.now(), ...overrides,
  };
}

describe("constraint origin mining", () => {
  it("marks only directly typed human rules as human-origin", () => {
    const messages = [
      user(RULE),
      user("Research handoff:\n- " + RULE, "smart-context-report"),
      user(RULE, DUP_TYPE),
    ];
    const constraints = extractStructured(messages, PROFILES.balanced).constraints;
    expect(constraints.map((item) => item.text)).toEqual([RULE]);
    expect(constraints[0].origin).toBe("human");
  });

  it("never marks carried summary lines, even when the user's copy left the window", () => {
    const messages = [carriedSummary(RULE), user(RULE, DUP_TYPE)];
    const constraints = extractStructured(messages, PROFILES.balanced).constraints;
    expect(constraints).toEqual([]);
  });

  it("upgrades a carried copy when the user types the rule in the same window", () => {
    const messages = [carriedSummary(RULE), user("One more thing."), user(RULE)];
    const constraints = extractStructured(messages, PROFILES.balanced).constraints;
    expect(constraints).toHaveLength(1);
    expect(constraints.map((item) => [item.text, item.origin])).toEqual([[RULE, "human"]]);
  });

  it("does not let producing provider or api decide human authorship", async () => {
    for (const api of ["anthropic-messages", "openai-responses", "openai-completions"] as const) {
      const session = SessionManager.inMemory();
      session.appendMessage({ role: "user", content: RULE, timestamp: 1 });
      session.appendMessage({
        role: "assistant", content: [{ type: "text", text: "Understood." }], stopReason: "stop",
        api, provider: api.split("-")[0], model: "m", timestamp: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } as AssistantMessage);
      session.appendCustomMessageEntry(DUP_TYPE, RULE, true);
      const { messages } = await recoverSourceMessages(session.getSessionId(), contextMessageEntries(session.getBranch()), "/tmp");
      const llm = messages.map((item) => item.message);
      const constraints = extractStructured(llm, PROFILES.balanced).constraints;
      expect(constraints.map((item) => [item.text, item.origin]), api).toEqual([[RULE, "human"]]);
    }
  });
});

describe("human-origin continuity across compactions", () => {
  let home: string;
  const previousHome = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "smart-compact-origin-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function harness() {
    const cwd = path.join(home, "project");
    fs.mkdirSync(cwd, { recursive: true });
    const session = SessionManager.inMemory(cwd);
    const headId = session.appendMessage({ role: "user", content: GOAL, timestamp: 1 });
    const projectId = deriveProjectIdFromCwd(cwd)!;
    const scope = { schemaVersion: 2 as const, projectId, sessionId: session.getSessionId(), branchHeadId: headId };
    const reload = (llmMessages: LlmMessage[]) => loadExtractionContinuity(
      { cwd, branch: session.getBranch(), sessionId: session.getSessionId(), llmMessages },
      extractStructured(llmMessages, PROFILES.balanced),
    );
    return { scope, projectId, save: (state: CompactionState) => saveCompactionState(projectId, { ...state, scope }), reload };
  }

  it("keeps the rule through two compact cycles while an extension repeats it", () => {
    const { projectId, save, reload } = harness();

    // Cycle 1: the user types the rule; the state step persists it.
    const firstWindow = [user(GOAL), user(RULE)];
    const firstExtraction = extractStructured(firstWindow, PROFILES.balanced);
    expect(firstExtraction.constraints.map((item) => [item.text, item.origin])).toEqual([[RULE, "human"]]);
    const firstState = mergeCompactionStates(null, buildCompactionState(firstExtraction, [], null, [], []));
    expect(firstState.constraints[0].origin).toBe("human");
    save(firstState);

    // Cycle 2: the authoring turn is gone; a non-quoting custom message repeats
    // the rule verbatim. The saved human rule must survive the filter.
    const secondWindow = [carriedSummary(RULE), user(GOAL), user(RULE, DUP_TYPE)];
    const second = reload(secondWindow);
    const human = (state: CompactionState) =>
      state.constraints.find((item) => normalizeFactKey(item.text) === normalizeFactKey(RULE));
    expect(human(second.previousState!)).toMatchObject({ origin: "human" });
    expect(human(second.verificationContinuity)).toMatchObject({ origin: "human", confidence: 0.8 });
    expect(second.continuity).toContain("- Constraint: " + RULE);

    // Cycle 3: same repetition one compaction later.
    save(second.verificationContinuity);
    const third = reload([carriedSummary(RULE), user(GOAL), user(RULE, DUP_TYPE)]);
    expect(human(third.previousState!)).toMatchObject({ origin: "human" });
    expect(human(third.verificationContinuity)).toMatchObject({ origin: "human" });
    expect(third.continuity).toContain("- Constraint: " + RULE);
  });

  it("writes the preserved human rule into the fallback and both gates require it", () => {
    const { save, reload } = harness();
    save(mergeCompactionStates(null, buildCompactionState(extractStructured([user(GOAL), user(RULE)], PROFILES.balanced), [], null, [], [])));
    const secondWindow = [carriedSummary(RULE), user(GOAL), user(RULE, DUP_TYPE)];
    const second = reload(secondWindow);
    const extractionB = extractStructured(secondWindow, PROFILES.balanced);
    // The deterministic floor must carry the rule even though fresh extraction
    // dropped it as an injected duplicate.
    const fallback = assembleFallback([], extractionB, {}, 6_000, second.verificationContinuity, second.factOverrides);
    expect(fallback).toContain("- " + RULE);
    expect(verifySummary(fallback, extractionB, second.verificationContinuity, { factOverrides: second.factOverrides }).ok).toBe(true);
    const missing = fallback.split("\n").filter((line) => line !== "- " + RULE).join("\n");
    // Pre-summary gate view: the merged continuity preview.
    const preGate = verifySummary(missing, extractionB, second.verificationContinuity, { factOverrides: second.factOverrides });
    expect(preGate.ok).toBe(false);
    expect(preGate.gaps.some((gap) => gap.kind === "missing-constraint")).toBe(true);
    // Post-state gate view: the saved state the next cycle loads.
    save(second.verificationContinuity);
    const thirdWindow = [carriedSummary(RULE), user(GOAL)];
    const third = reload(thirdWindow);
    const postGate = verifySummary(missing, extractStructured(thirdWindow, PROFILES.balanced), third.previousState, { factOverrides: third.factOverrides });
    expect(postGate.ok).toBe(false);
    expect(postGate.gaps.some((gap) => gap.kind === "missing-constraint")).toBe(true);
  });

  it("keeps a released-then-reasserted rule active through the real continuity load", () => {
    const { save, reload } = harness();
    save(savedState({
      constraints: [{ id: "constraint-1", text: RELEASED_RULE, category: "prohibition", confidence: 0.8 }],
    }));
    // The saved copy predates the window; the user releases, then re-types it.
    const continuity = reload([carriedSummary(RELEASED_RULE), user(RELEASE), user(RELEASED_RULE)]);
    expect(
      continuity.factOverrides.filter(
        (item) => item.kind === "constraint" && item.status !== "active",
      ),
    ).toEqual([]);
    const active = (state: CompactionState) =>
      state.constraints.some((item) => normalizeFactKey(item.text) === normalizeFactKey(RELEASED_RULE));
    expect(active(continuity.previousState!)).toBe(true);
    expect(active(continuity.verificationContinuity)).toBe(true);
    expect(continuity.continuity).toContain("- Constraint: " + RELEASED_RULE);
  });

  it("a fresh raw reassertion revives a released rule; a summary copy alone never does", () => {
    const { save, reload } = harness();
    const retired: ContinuityOverride = {
      id: "constraint-override-1",
      kind: "constraint",
      summaryKey: normalizeFactKey(RELEASED_RULE),
      status: "superseded",
      replacement: RELEASE,
      updatedAt: Date.now(),
    };
    save(savedState({
      constraints: [{ id: "constraint-1", text: RELEASED_RULE, category: "prohibition", confidence: 0.8 }],
      factOverrides: [retired],
    }));
    // Carried summary copy only: the release stands, nothing resurrects.
    const summaryOnly = reload([carriedSummary(RELEASED_RULE), user(GOAL)]);
    expect(summaryOnly.verificationContinuity.constraints.map((item) => item.text)).not.toContain(RELEASED_RULE);
    expect(
      summaryOnly.factOverrides.some(
        (item) => item.summaryKey === normalizeFactKey(RELEASED_RULE) && item.status === "superseded",
      ),
    ).toBe(true);
    // A genuinely newer raw typing (timestamp after the override decision)
    // clears the old override and revives the rule; an old raw author still
    // projected (timestamp before the decision) would not.
    const reasserted = reload([
      carriedSummary(RELEASED_RULE),
      user(GOAL),
      user(RELEASED_RULE, undefined, retired.updatedAt + 1),
    ]);
    expect(
      reasserted.factOverrides.some((item) => item.summaryKey === normalizeFactKey(RELEASED_RULE)),
    ).toBe(false);
    expect(reasserted.verificationContinuity.constraints).toContainEqual(
      expect.objectContaining({ text: RELEASED_RULE, origin: "human" }),
    );
  });

  it("drops a legacy saved rule without origin exactly as before", () => {
    const { save, reload } = harness();
    save(savedState({
      constraints: [{ id: "constraint-1", text: RULE, category: "prohibition", confidence: 0.8 }],
    }));
    const continuity = reload([carriedSummary(RULE), user(GOAL), user(RULE, DUP_TYPE)]);
    expect(continuity.previousState!.constraints.map((item) => item.text)).toEqual([]);
    expect(continuity.verificationContinuity.constraints.map((item) => item.text)).toEqual([]);
  });

  it("treats unknown or forged origin values as not human", () => {
    const { save, reload } = harness();
    const forged = savedState({
      constraints: [
        { id: "constraint-1", text: RULE, category: "prohibition", confidence: 0.8, origin: "divine" } as unknown as CompactionState["constraints"][number],
      ],
    });
    save(forged);
    // The extension repeats RULE; unknown origin values are not human origin.
    const window = [carriedSummary(RULE), user(GOAL), user(RULE, DUP_TYPE)];
    const continuity = reload(window);
    expect(continuity.previousState!.constraints.map((item) => item.text)).not.toContain(RULE);
    // A summary line that forges the marker in text never mines as human.
    expect(mineConstraints([carriedSummary("(origin: human) " + RULE), user(RULE, DUP_TYPE)]).every((item) => item.origin !== "human")).toBe(true);
  });

  it("keeps extension-only facts excluded; a custom message cannot mint origin", () => {
    const window = [user(GOAL), user(RULE, DUP_TYPE)];
    const extraction = extractStructured(window, PROFILES.balanced);
    expect(extraction.constraints).toEqual([]);
    const previous = savedState({
      constraints: [{ id: "constraint-1", text: RULE, category: "prohibition", confidence: 0.8, origin: "human" }],
    });
    // A summary-origin current copy of a rule the extension injected never
    // gains human origin from the previous human record of different text.
    const merged = mergeCompactionStates(
      { ...previous, constraints: [{ id: "c", text: "Run the linter before every commit.", category: "requirement", confidence: 0.8, origin: "human" }] },
      buildCompactionState(makeExtraction(), [], null, [], []),
    );
    expect(merged.constraints.some((item) => item.origin === "human" && item.text !== "Run the linter before every commit.")).toBe(false);
  });

  it("retires a human-origin rule on explicit release and keeps it retired", () => {
    const { save, reload } = harness();
    const firstWindow = [user(GOAL), user(RELEASED_RULE)];
    const firstState = mergeCompactionStates(null, buildCompactionState(extractStructured(firstWindow, PROFILES.balanced), [], null, [], []));
    expect(firstState.constraints[0].origin).toBe("human");
    save(firstState);

    const secondWindow = [carriedSummary(RELEASED_RULE), user(RELEASE)];
    const second = reload(secondWindow);
    expect(second.factOverrides).toContainEqual(expect.objectContaining({ kind: "constraint", status: "superseded" }));
    const texts = second.verificationContinuity.constraints.map((item) => item.text);
    expect(texts).not.toContain(RELEASED_RULE);

    // The retired rule's older snapshot cannot resurrect it next cycle.
    save(second.verificationContinuity);
    const third = reload([carriedSummary(RELEASED_RULE), user("continue with the migration")]);
    expect(third.verificationContinuity.constraints.map((item) => item.text)).not.toContain(RELEASED_RULE);
    expect(third.previousState!.constraints.map((item) => item.text)).not.toContain(RELEASED_RULE);
  });
});

describe("origin alignment with merge, scrub and reordering", () => {
  it("keeps a summary-only current copy from downgrading an equal older human record", () => {
    const previous = savedState({
      constraints: [{ id: "constraint-1", text: RULE, category: "prohibition", confidence: 0.8, origin: "human" }],
    });
    const current = buildCompactionState(
      makeExtraction({ constraints: [{ index: 0, text: RULE, category: "prohibition", confidence: 0.8 }] }),
      [], null, [], [],
    );
    const merged = mergeCompactionStates(previous, current);
    expect(merged.constraints).toHaveLength(1);
    expect(merged.constraints[0].origin).toBe("human");
  });

  it("keeps origin attached to the correct rule through current-first reordering", () => {
    const previous = savedState({
      constraints: [
        { id: "constraint-1", text: "Run the linter before every commit.", category: "requirement", confidence: 0.85 },
        { id: "constraint-2", text: RULE, category: "prohibition", confidence: 0.8, origin: "human" },
      ],
    });
    const current = buildCompactionState(
      makeExtraction({
        constraints: [
          { index: 0, text: "Run the linter before every commit.", category: "requirement", confidence: 0.85 },
          { index: 1, text: "Ship the release notes with every tag.", category: "requirement", confidence: 0.85 },
        ],
      }),
      [], null, [], [],
    );
    const merged = mergeCompactionStates(previous, current);
    const byText = new Map(merged.constraints.map((item) => [item.text, item.origin]));
    expect(byText.get(RULE)).toBe("human");
    expect(byText.get("Run the linter before every commit.")).toBeUndefined();
    expect(byText.get("Ship the release notes with every tag.")).toBeUndefined();
  });

  it("keeps origin on the same record when the scrubber redacts the rule text", () => {
    const KEY = "AKIAIOSFODNN7EXAMPLE";
    const extraction = makeExtraction({
      constraints: [
        { index: 0, text: "Never commit the key " + KEY + " to the repo.", category: "prohibition", confidence: 0.8, origin: "human" },
        { index: 1, text: "Ship the release notes with every tag.", category: "requirement", confidence: 0.85 },
      ],
    });
    const scrubbed = new SecretScrubber(true, false).scrubValue(extraction).value;
    expect(scrubbed.constraints).toHaveLength(2);
    expect(scrubbed.constraints[0].text).not.toContain(KEY);
    expect(scrubbed.constraints[0].origin).toBe("human");
    expect(scrubbed.constraints[1].origin).toBeUndefined();
    // The redacted human record keeps its identity through the state merge.
    const state = buildCompactionState(scrubbed, [], null, [], []);
    expect(state.constraints[0].origin).toBe("human");
    expect(state.constraints[0].text).toBe(scrubbed.constraints[0].text);
  });
});

describe("origin across equal copies in cache and state merges", () => {
  it("keeps a newly human-origin equal rule at incremental state dedup", () => {
    const baseWindow = [carriedSummary(RELEASED_RULE)];
    const all = [...baseWindow, user(RELEASED_RULE)];
    const base = extractStructured(baseWindow, PROFILES.balanced);
    expect(base.constraints[0].origin).toBeUndefined();
    const ids = all.map((_, index) => "m-" + index);
    const selection = selectCachedExtraction({
      llmMessages: all, profileCfg: PROFILES.balanced, currentEntryIds: ids, currentKeptEntryIds: ids,
      cachedExt: {
        generation: VERSION, extraction: base, lastMessageIndex: 0, messageCount: 1, timestamp: Date.now(),
        entryIdsFp: buildEntryIdFingerprint(ids.slice(0, 1)), keptEntryIdsFp: buildEntryIdFingerprint(ids.slice(0, 1)),
        messagePrefixHash: hashMessages(all, 1),
      },
    });
    expect(selection.cache).toBe("incremental");
    // Current-first dedup keeps the earlier carried copy; the later raw human
    // retyping in the same run must not lose its origin at the state merge.
    const saved = mergeCompactionStates(
      buildCompactionState(base, [], null, [], []),
      buildCompactionState(selection.extraction, [], null, [], []),
    );
    expect(saved.constraints).toHaveLength(1);
    expect(saved.constraints[0]).toMatchObject({ text: RELEASED_RULE, origin: "human" });
  });

  it("keeps known origin on the equal surviving summary copy at the cache bound", () => {
    const count = EXTRACTION_LIMITS.CONSTRAINTS;
    const lines = [RELEASED_RULE, ...Array.from({ length: count - 1 }, (_, i) => "Never change sentinel " + i + " without approval.")];
    const base = extractStructured([user(lines.join("\n"))], PROFILES.balanced);
    expect(base.constraints).toHaveLength(count);
    expect(base.constraints[0]).toMatchObject({ text: RELEASED_RULE, origin: "human" });
    const delta = extractStructured([carriedSummary(RELEASED_RULE)], PROFILES.balanced);
    const merged = mergeExtractions(base, delta, 1, [carriedSummary(RELEASED_RULE)], new Map());
    expect(merged.constraints.length).toBeLessThanOrEqual(count);
    expect(merged.constraints).toContainEqual(expect.objectContaining({ text: RELEASED_RULE, origin: "human" }));
  });

  it("an earlier release cannot retire a later reasserted human rule", () => {
    const messages = [carriedSummary(RELEASED_RULE), user(RELEASE), user(RELEASED_RULE)];
    const extraction = extractStructured(messages, PROFILES.balanced);
    const rule = extraction.constraints.find((item) => item.text === RELEASED_RULE);
    expect(rule).toMatchObject({ origin: "human", index: 2 });
    expect(retireSupersededConstraints(extraction.constraints, messages, [])).toEqual([]);
  });

  it("union copies cannot let a previous unindexed record cancel a later human reassertion", () => {
    // loadExtractionContinuity passes current extraction records plus equal
    // previous-state copies (no index) to retirement in one union.
    const messages = [user(RELEASE), user(RELEASED_RULE)];
    const extraction = extractStructured(messages, PROFILES.balanced);
    expect(
      retireSupersededConstraints(
        [...extraction.constraints, { text: RELEASED_RULE, confidence: 0.8 }],
        messages,
        [],
      ),
    ).toEqual([]);
  });

  it("warm incremental merged copies cannot cancel the newest raw author", () => {
    const messages = [carriedSummary(RELEASED_RULE), user(RELEASE), user(RELEASED_RULE)];
    const base = extractStructured(messages.slice(0, 1), PROFILES.balanced);
    const merged = mergeExtractions(
      base,
      extractStructured(messages.slice(1), PROFILES.balanced),
      1,
      messages.slice(1),
      new Map(),
    );
    expect(
      retireSupersededConstraints(
        [...merged.constraints, { text: RELEASED_RULE, confidence: 0.8 }],
        messages,
        [],
      ),
    ).toEqual([]);
  });

  it("a later carried copy after release is not a human reassertion (warm equals fresh)", () => {
    // The raw author sits at index 0, the release at 1, the summary copy at 2.
    // The cache grafts origin onto the summary copy; only the raw message
    // proves a fresh assertion, so warm retirement must match fresh mining.
    const messages = [user(RELEASED_RULE), user(RELEASE), carriedSummary(RELEASED_RULE)];
    const fresh = extractStructured(messages, PROFILES.balanced);
    const warm = mergeExtractions(
      extractStructured(messages.slice(0, 2), PROFILES.balanced),
      extractStructured(messages.slice(2), PROFILES.balanced),
      2,
      messages.slice(2),
      new Map(),
    );
    const expected = retireSupersededConstraints(fresh.constraints, messages, []);
    expect(expected.some((item) => item.status === "superseded")).toBe(true);
    expect(
      retireSupersededConstraints(warm.constraints, messages, []).some(
        (item) => item.status === "superseded",
      ),
    ).toBe(true);
  });

  it("an older raw author still visible cannot undo a newer manual resolution", () => {
    const messages = [user(RELEASED_RULE, undefined, 1)];
    const overrides = upsertContinuityOverride([], "constraint", RELEASED_RULE, { status: "resolved" });
    expect(retireSupersededConstraints(extractStructured(messages, PROFILES.balanced).constraints, messages, overrides)).toEqual(overrides);
  });

  it("a causally newer direct human reassertion supersedes the old resolution", () => {
    const overrides = upsertContinuityOverride([], "constraint", RELEASED_RULE, { status: "resolved" });
    const messages = [user(RELEASED_RULE, undefined, overrides[0].updatedAt + 1)];
    expect(
      retireSupersededConstraints(extractStructured(messages, PROFILES.balanced).constraints, messages, overrides).some(
        (item) => item.status !== "active",
      ),
    ).toBe(false);
  });

  it("a human-first reassertion also advances the source author index", () => {
    const messages = [user(RELEASED_RULE), user(RELEASE), user(RELEASED_RULE)];
    const extraction = extractStructured(messages, PROFILES.balanced);
    expect(extraction.constraints.find((item) => item.text === RELEASED_RULE)?.index).toBe(2);
    expect(retireSupersededConstraints(extraction.constraints, messages, [])).toEqual([]);
  });
});
