/**
 * Damage detection covers the post-compaction "did we lose something
 * important" question. The audit (kimi #17) flagged that this critical
 * module had zero direct test coverage; if the heuristics regress, we'd
 * only notice when a user complains.
 *
 * What we exercise:
 *
 *   - Re-read signal: agent reads a file that was already summarized.
 *   - User-complaint signal: user message matches a complaint pattern.
 *   - Re-question signal: user mentions a topic from the compacted section.
 *   - Damage score scales with signal severity (high=25, medium=10, low=3).
 *   - Clean post-compaction history → score 0, "No regression signals".
 *   - Non-matching reads → no false positive.
 */

import { describe, it, expect } from "bun:test";
import { detectDamage, OnlineDamageMonitor } from "../src/utils/damage.ts";
import type { LlmMessage, SmartCompactDetails } from "../src/types.ts";

function userMsg(text: string): LlmMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantToolCall(name: string, args: Record<string, unknown>): LlmMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc-" + Math.random().toString(36).slice(2), name, arguments: args }],
    timestamp: Date.now(),
  };
}

function assistantText(text: string): LlmMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
}

function makeDetails(over: Partial<SmartCompactDetails> = {}): SmartCompactDetails {
  return {
    method: "eesv",
    chunkCount: 3,
    topics: ["Refactor authentication module"],
    readFiles: ["src/old-config.ts"],
    modifiedFiles: ["src/auth.ts"],
    totalMessages: 50,
    totalTokensSummarized: 12000,
    llmCalls: 5,
    profile: "balanced",
    backupPath: null,
    tokensSaved: 8000,
    verified: true,
    gaps: [],
    explorationRounds: 2,
    explorationBoundaries: 4,
    model: "openai/gpt-5",
    qualityScore: 90,
    tokensBefore: 20000,
    ...over,
  };
}

describe("OnlineDamageMonitor", () => {
  it("activates after compaction and emits the first actionable observation", () => {
    const monitor = new OnlineDamageMonitor(15);
    monitor.activate("session-1", "project-1", makeDetails());
    const observation = monitor.observe("session-1", assistantToolCall("read", { path: "src/auth.ts" }));
    expect(observation?.report.damageScore).toBeGreaterThan(0);
    expect(observation?.projectId).toBe("project-1");
    expect(monitor.size()).toBe(0);
  });

  it("stops a clean monitor at the configured message window", () => {
    const monitor = new OnlineDamageMonitor(2);
    monitor.activate("session-1", "project-1", makeDetails());
    expect(monitor.observe("session-1", assistantText("continue"))).toBeNull();
    const observation = monitor.observe("session-1", assistantText("done"));
    expect(observation?.report.damageScore).toBe(0);
    expect(monitor.size()).toBe(0);
  });
});

describe("detectDamage", () => {
  it("reports zero score for a clean post-compaction history", () => {
    const messages: LlmMessage[] = [
      userMsg("Let's continue working on the new feature."),
      assistantText("Sure, what should we tackle next?"),
    ];
    const report = detectDamage(messages, makeDetails());
    expect(report.damageScore).toBe(0);
    expect(report.signals).toHaveLength(0);
    expect(report.summary).toContain("No regression signals");
  });

  it("flags a re-read when the agent reads a previously modified file", () => {
    const messages: LlmMessage[] = [
      assistantToolCall("read", { path: "src/auth.ts" }),
    ];
    const report = detectDamage(messages, makeDetails());
    const reReads = report.signals.filter(s => s.type === "re-read");
    expect(reReads).toHaveLength(1);
    expect(reReads[0].severity).toBe("medium");
    // Remediation: the re-read path is collected for the next compaction.
    expect(report.reReadFiles).toEqual(["src/auth.ts"]);
    // The score should reflect a medium-severity signal (10 points).
    expect(report.damageScore).toBe(10);
    expect(report.summary).toContain("1 re-read");
  });

  it("flags a re-read when the agent reads a previously read file too", () => {
    const messages: LlmMessage[] = [
      assistantToolCall("read", { path: "src/old-config.ts" }),
    ];
    const report = detectDamage(messages, makeDetails());
    expect(report.signals.some(s => s.type === "re-read")).toBe(true);
  });

  it("does not mistake a path + text mutation for a re-read", () => {
    const messages: LlmMessage[] = [
      assistantToolCall("write_file", { path: "src/auth.ts", text: "replacement" }),
    ];
    const report = detectDamage(messages, makeDetails());
    expect(report.signals.filter(s => s.type === "re-read")).toHaveLength(0);
  });

  it("does not flag a re-read for a file that was never in the compacted section", () => {
    const messages: LlmMessage[] = [
      assistantToolCall("read", { path: "src/brand-new-file.ts" }),
    ];
    const report = detectDamage(messages, makeDetails());
    expect(report.signals.filter(s => s.type === "re-read")).toHaveLength(0);
    expect(report.damageScore).toBe(0);
    expect(report.reReadFiles).toEqual([]);
  });

  it("detects a user complaint as a high-severity signal", () => {
    // Complaint patterns include phrases like "you forgot", "you missed",
    // "where is", "did we lose". The high severity (25 pts) is what makes
    // this the dominant signal in the report.
    const messages: LlmMessage[] = [
      userMsg("Hey, you forgot what we discussed about the auth flow earlier."),
    ];
    const report = detectDamage(messages, makeDetails());
    const complaints = report.signals.filter(s => s.type === "user-complaint");
    expect(complaints.length).toBeGreaterThan(0);
    expect(complaints[0].severity).toBe("high");
    expect(report.damageScore).toBeGreaterThanOrEqual(25);
  });

  it("detects a re-question when the user mentions a compacted topic", () => {
    // Salient-keyword match: "Refactor" (capitalized → salient token) from the
    // compacted topic appears in the user's re-question.
    const messages: LlmMessage[] = [
      userMsg("Can you remind me what we decided about the refactor authentication?"),
    ];
    const report = detectDamage(messages, makeDetails());
    const reQs = report.signals.filter(s => s.type === "re-question");
    expect(reQs.length).toBeGreaterThan(0);
    expect(reQs[0].severity).toBe("low");
  });

  it("caps the damage score at 100 even with many signals", () => {
    // Stack enough high-severity signals to push past 100 (5 x 25 = 125).
    const messages: LlmMessage[] = Array.from({ length: 5 }, () =>
      userMsg("you forgot what we discussed earlier"),
    );
    const report = detectDamage(messages, makeDetails());
    expect(report.damageScore).toBeLessThanOrEqual(100);
  });

  it("handles a malformed details object gracefully via empty arrays", () => {
    // detectDamage internally builds Sets from modifiedFiles/readFiles/topics.
    // The type-guards layer should sanitize before this point, but we still
    // want detectDamage itself to behave when handed empty arrays.
    const messages: LlmMessage[] = [
      assistantToolCall("read", { path: "src/anything.ts" }),
      userMsg("question about something"),
    ];
    const report = detectDamage(messages, makeDetails({
      modifiedFiles: [], readFiles: [], topics: [],
    }));
    // No compacted files to match against → no re-read or re-question.
    expect(report.signals.filter(s => s.type === "re-read")).toHaveLength(0);
    expect(report.signals.filter(s => s.type === "re-question")).toHaveLength(0);
  });
});
