import { describe, it, expect } from "bun:test";
import { deriveProjectId, buildProjectContext } from "../src/utils/fingerprint.ts";
import type { StructuredExtraction } from "../src/types.ts";

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 0,
    ...partial,
  };
}

function posixJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

const HOME = "/Users/example";
const DEV_ROOT = posixJoin(HOME, "dev");
const AGENT_ROOT = posixJoin(HOME, ".pi", "agent");

const repoPath = (projectRoot: string, ...parts: string[]) => posixJoin(DEV_ROOT, projectRoot, ...parts);
const agentPath = (...parts: string[]) => posixJoin(AGENT_ROOT, ...parts);
const npmCachePath = (...parts: string[]) => posixJoin(HOME, ".npm", "_cacache", ...parts);
const cachePath = (...parts: string[]) => posixJoin(HOME, ".cache", ...parts);

// ── Basic stability ──

describe("deriveProjectId — stability", () => {
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
    expect(deriveProjectId(makeExtraction())).toBe("unknown");
  });

  it("is deterministic across calls with same data", () => {
    const ext = makeExtraction({
      readFiles: ["a.ts", "b.ts", "c.ts"],
    });
    const results = Array.from({ length: 10 }, () => deriveProjectId(ext));
    expect(new Set(results).size).toBe(1);
  });
});

// ── Cross-project collision regression ──

describe("deriveProjectId — collision resistance", () => {
  it("produces DIFFERENT IDs for different projects (absolute paths)", () => {
    const projectA = makeExtraction({
      modifiedFiles: [
        { path: repoPath("workspace-alpha/repo-core", "src/core.ts"), toolCalls: 1, lastModifiedIndex: 1 },
        { path: repoPath("workspace-alpha/repo-core", "README.md"), toolCalls: 1, lastModifiedIndex: 3 },
      ],
    });
    const projectB = makeExtraction({
      modifiedFiles: [
        { path: repoPath("workspace-beta/repo-agent", "src/tools/index.ts"), toolCalls: 1, lastModifiedIndex: 1 },
        { path: repoPath("workspace-beta/repo-agent", "README.md"), toolCalls: 1, lastModifiedIndex: 2 },
      ],
    });
    expect(deriveProjectId(projectA)).not.toBe(deriveProjectId(projectB));
  });

  it("produces DIFFERENT IDs for different projects (relative paths)", () => {
    const projectA = makeExtraction({
      readFiles: ["src/core.ts", "src/index.ts", "src/utils/helpers.ts", "README.md", "package.json"],
    });
    const projectB = makeExtraction({
      readFiles: ["web/src/app.tsx", "web/src/routes.ts", "extensions/main.js", "docs/guide.md"],
    });
    expect(deriveProjectId(projectA)).not.toBe(deriveProjectId(projectB));
  });

  it("does NOT use 'root' or '/Users' as project root (regression)", () => {
    // Old bug: relative-only paths → hash("root") = proj-4813494d
    // Old bug: absolute /Users paths → hash("/Users") = proj-a2a0ee2c
    const OLD_ROOT_BUG = "proj-4813494d137e";
    const OLD_USERS_BUG = "proj-a2a0ee2c7174";

    const relativeExt = makeExtraction({
      modifiedFiles: [
        { path: "src/index.ts", toolCalls: 1, lastModifiedIndex: 1 },
        { path: "README.md", toolCalls: 1, lastModifiedIndex: 3 },
      ],
    });
    const absoluteExt = makeExtraction({
      modifiedFiles: [
        { path: repoPath("workspace-alpha/repo-core", "src/core.ts"), toolCalls: 1, lastModifiedIndex: 1 },
        { path: repoPath("workspace-beta/repo-agent", "README.md"), toolCalls: 1, lastModifiedIndex: 2 },
      ],
    });

    expect(deriveProjectId(relativeExt)).not.toBe(OLD_ROOT_BUG);
    expect(deriveProjectId(absoluteExt)).not.toBe(OLD_USERS_BUG);
  });
});

// ── Noise path filtering ──

describe("deriveProjectId — noise filtering", () => {
  it("ignores node_modules paths", () => {
    const clean = makeExtraction({
      modifiedFiles: [
        { path: repoPath("project-a", "src/main.ts"), toolCalls: 1, lastModifiedIndex: 1 },
        { path: repoPath("project-a", "README.md"), toolCalls: 1, lastModifiedIndex: 2 },
      ],
    });
    const withNoise = makeExtraction({
      modifiedFiles: [
        { path: repoPath("project-a", "src/main.ts"), toolCalls: 1, lastModifiedIndex: 1 },
        { path: repoPath("project-a", "README.md"), toolCalls: 1, lastModifiedIndex: 2 },
      ],
      readFiles: [
        npmCachePath("tmp", "abc.json"),
        "node_modules/lodash/index.js",
      ],
    });
    // Should produce the same ID regardless of noise paths
    expect(deriveProjectId(clean)).toBe(deriveProjectId(withNoise));
  });

  it("ignores .pi/agent infrastructure paths", () => {
    const clean = makeExtraction({
      readFiles: ["src/core.ts", "src/utils/helpers.ts", "package.json"],
    });
    const withPiNoise = makeExtraction({
      readFiles: [
        "src/core.ts",
        "src/utils/helpers.ts",
        "package.json",
        agentPath("npm", "node_modules", "pi-smart-compact", "package.json"),
        agentPath("settings.json"),
      ],
    });
    expect(deriveProjectId(clean)).toBe(deriveProjectId(withPiNoise));
  });

  it("returns 'unknown' when all paths are noise", () => {
    const noiseOnly = makeExtraction({
      readFiles: [
        "node_modules/react/index.js",
        cachePath("something.json"),
      ],
    });
    expect(deriveProjectId(noiseOnly)).toBe("unknown");
  });
});

// ── Absolute path deep ancestor ──

describe("deriveProjectId — absolute path resolution", () => {
  it("finds the correct deep project root for a single project", () => {
    const ext = makeExtraction({
      modifiedFiles: [
        { path: repoPath("myproject", "src/a.ts"), toolCalls: 1, lastModifiedIndex: 1 },
        { path: repoPath("myproject", "src/b.ts"), toolCalls: 1, lastModifiedIndex: 2 },
        { path: repoPath("myproject", "package.json"), toolCalls: 1, lastModifiedIndex: 3 },
      ],
    });
    const id1 = deriveProjectId(ext);

    // Adding more files from the same project should give the same ID
    const ext2 = makeExtraction({
      ...ext,
      readFiles: [repoPath("myproject", "README.md")],
    });
    expect(deriveProjectId(ext2)).toBe(id1);
  });

  it("does not collide when one project dominates with modifications", () => {
    // A session primarily working on project-x with a stray read from project-y
    // should NOT produce the same ID as a pure project-y session
    const primary = makeExtraction({
      modifiedFiles: [
        { path: repoPath("project-x", "src/main.ts"), toolCalls: 3, lastModifiedIndex: 5 },
        { path: repoPath("project-x", "src/util.ts"), toolCalls: 2, lastModifiedIndex: 8 },
        { path: repoPath("project-x", "test/main.test.ts"), toolCalls: 1, lastModifiedIndex: 10 },
      ],
      readFiles: [repoPath("project-y", "README.md")], // one stray read
    });
    const otherProject = makeExtraction({
      modifiedFiles: [
        { path: repoPath("project-y", "src/index.ts"), toolCalls: 1, lastModifiedIndex: 1 },
        { path: repoPath("project-y", "README.md"), toolCalls: 1, lastModifiedIndex: 2 },
      ],
    });
    // The primary session (project-x) must not get confused with project-y
    expect(deriveProjectId(primary)).not.toBe(deriveProjectId(otherProject));
  });
});

// ── buildProjectContext ──

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
