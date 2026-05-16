import { describe, it, expect } from "bun:test";
import { deriveProjectId, detectLanguage, detectFramework, loadProjectFingerprint, buildProjectContext } from "../src/utils/fingerprint.ts";
import type { StructuredExtraction } from "../src/types.ts";

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 0,
    ...partial,
  };
}

describe("deriveProjectId", () => {
  it("returns a stable ID for the same files", () => {
    const ext = makeExtraction({
      modifiedFiles: [
        { path: "src/index.ts", toolCalls: 1, lastModifiedIndex: 1 },
        { path: "src/auth.ts", toolCalls: 2, lastModifiedIndex: 5 },
      ],
    });
    const id1 = deriveProjectId(ext);
    const id2 = deriveProjectId(ext);
    expect(id1).toBe(id2);
    expect(id1.startsWith("proj-")).toBe(true);
  });

  it("returns unknown for empty extraction", () => {
    const ext = makeExtraction();
    expect(deriveProjectId(ext)).toBe("unknown");
  });
});

describe("buildProjectContext", () => {
  it("returns empty string for null fingerprint", () => {
    expect(buildProjectContext(null)).toBe("");
  });

  it("builds context from fingerprint", () => {
    const ctx = buildProjectContext({
      id: "proj-test",
      language: "typescript",
      framework: "react",
      keyDirectories: ["src/components", "src/hooks"],
      knownFiles: ["src/index.ts"],
      sessionCount: 5,
      updatedAt: Date.now(),
    });
    expect(ctx).toContain("typescript");
    expect(ctx).toContain("react");
    expect(ctx).toContain("5 session");
  });
});
