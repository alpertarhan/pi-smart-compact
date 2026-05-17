/**
 * Lightweight project fingerprint for cross-session context.
 * Stores basic project metadata to improve compaction accuracy.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { StructuredExtraction } from "../types.ts";
import * as log from "./logger.ts";

export interface ProjectFingerprint {
  id: string;
  language: string;
  framework: string | null;
  keyDirectories: string[];
  knownFiles: string[];
  sessionCount: number;
  updatedAt: number;
}

const FINGERPRINT_DIR = path.join(process.env.HOME ?? "/tmp", ".pi", "agent", ".cache", "smart-compact", "projects");

// Language detection heuristics from file extensions
const LANG_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript",
  ".rs": "rust",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".cs": "csharp",
  ".cpp": "cpp", ".c": "c", ".h": "c",
  ".swift": "swift",
  ".kt": "kotlin",
  ".php": "php",
};

// Framework detection from file paths and names
const FRAMEWORK_SIGNALS: Array<{ pattern: RegExp; framework: string }> = [
  { pattern: /next\.config/i, framework: "nextjs" },
  { pattern: /nuxt\.config/i, framework: "nuxt" },
  { pattern: /vite\.config/i, framework: "vite" },
  { pattern: /astro\.config/i, framework: "astro" },
  { pattern: /tailwind\.config/i, framework: "tailwind" },
  { pattern: /django/i, framework: "django" },
  { pattern: /flask/i, framework: "flask" },
  { pattern: /cargo\.toml/i, framework: "cargo" },
  { pattern: /go\.mod/i, framework: "go-modules" },
  { pattern: /Gemfile/i, framework: "bundler" },
  { pattern: /package\.json/i, framework: "node" },
];

function getFingerprintPath(projectId: string): string {
  return path.join(FINGERPRINT_DIR, projectId + ".json");
}

/**
 * Patterns matching paths from dependency/infrastructure directories
 * that must not influence project identity.
 *
 * Without this filter, paths like node_modules or .pi/agent/npm
 * would pollute the root detection and cause cross-project collisions.
 */
const NOISE_PATH_RE = /(?:node_modules|[/\\]\.pi[/\\]agent|[/\\]\.cache|[/\\]\.npm|[/\\]\.bun|[/\\]\.git[/\\])/;

function isProjectPath(filePath: string): boolean {
  return !NOISE_PATH_RE.test(filePath);
}

/** Hash a string seed into a short project ID. */
function hashProjectId(seed: string): string {
  return "proj-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

/**
 * Derive a stable project ID from absolute file paths.
 *
 * Algorithm:
 *  1. Normalize paths → strip leading /, split into segments
 *  2. Require minimum 3 segments for meaningful root identification
 *  3. Count how many paths fall under each directory prefix (depth 3+)
 *  4. Pick the **deepest** prefix that covers ≥ 50 % of paths
 *
 * This avoids the old bug where "root" or "/Users" was used as the
 * project root, causing cross-project fingerprint contamination.
 */
function deriveFromAbsolutePaths(paths: string[]): string {
  const segments = paths
    .map(p => p.replace(/^\/+/, "").split("/").filter(Boolean))
    .filter(s => s.length >= 3);

  if (segments.length < 2) return deriveFromRelativePaths(paths);

  // Count coverage of each directory prefix at depth 3+
  const dirCounts = new Map<string, number>();
  for (const segs of segments) {
    for (let depth = 3; depth <= segs.length; depth++) {
      const prefix = segs.slice(0, depth).join("/");
      dirCounts.set(prefix, (dirCounts.get(prefix) ?? 0) + 1);
    }
  }

  // Find deepest prefix covering ≥ 50 % of paths
  const threshold = Math.ceil(segments.length * 0.5);
  const candidates = [...dirCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => {
      const depthDiff = b[0].split("/").length - a[0].split("/").length;
      if (depthDiff !== 0) return depthDiff; // deeper is better
      return b[1] - a[1]; // more coverage is better
    });

  if (candidates.length) return hashProjectId(candidates[0][0]);

  // Fallback: longest common prefix
  const sorted = [...segments].sort((a, b) => a.length - b.length);
  let commonDepth = 0;
  for (let d = 0; d < sorted[0].length; d++) {
    if (segments.every(s => s[d] === sorted[0][d])) commonDepth = d + 1;
    else break;
  }
  return hashProjectId(sorted[0].slice(0, Math.max(commonDepth, 3)).join("/"));
}

/**
 * Derive a stable project ID from relative file paths.
 *
 * Because relative paths lack project-level depth, we build a
 * "directory structure fingerprint" — a sorted set of top-level
 * entries + the most common depth-2 directories. This is stable
 * across sessions as long as the project structure doesn't change.
 */
function deriveFromRelativePaths(paths: string[]): string {
  // Top-level entries (depth-1 segments)
  const topEntries = [...new Set(
    paths.map(p => p.split("/").filter(Boolean)[0]).filter(Boolean),
  )].sort();

  // Depth-2 directory frequency for specificity
  const dir2Counts = new Map<string, number>();
  for (const p of paths) {
    const segs = p.split("/").filter(Boolean);
    if (segs.length >= 2) {
      const d2 = segs.slice(0, 2).join("/");
      dir2Counts.set(d2, (dir2Counts.get(d2) ?? 0) + 1);
    }
  }

  // Take top 8 depth-2 dirs by frequency, then sort for determinism
  const stableDirs = [...dir2Counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([d]) => d)
    .sort();

  const fingerprint = topEntries.join(",") + "|" + stableDirs.join(",");
  return hashProjectId(fingerprint);
}

/**
 * Generate a stable project ID from file paths in the extraction.
 *
 * Strategy (in priority order):
 *  1. **Noise filtering** — exclude node_modules, .cache, .pi/agent, etc.
 *  2. **Absolute paths** (≥ 2) — deep ancestor with majority vote
 *  3. **Relative paths** (≥ 2) — directory structure fingerprint
 *  4. **Fallback** — hash all paths together
 *
 * ⚠️ Breaking change: this replaces the previous shallow-root algorithm
 *    that caused cross-project contamination
 *    (e.g. hash("root") → proj-4813494d, hash("/Users") → proj-a2a0ee2c).
 *    Old fingerprint/state files will be orphaned and expire via TTL.
 */
export function deriveProjectId(extraction: StructuredExtraction): string {
  const allPaths = [
    ...extraction.modifiedFiles.map(f => f.path),
    ...extraction.readFiles,
  ].filter(isProjectPath);

  if (!allPaths.length) return "unknown";

  const absolutePaths = allPaths.filter(p => p.startsWith("/"));
  const relativePaths = allPaths.filter(p => !p.startsWith("/"));

  // Strategy 1: Absolute paths → deep ancestor with majority vote
  if (absolutePaths.length >= 2) {
    return deriveFromAbsolutePaths(absolutePaths);
  }

  // Strategy 2: Relative paths → directory structure fingerprint
  if (relativePaths.length >= 2) {
    return deriveFromRelativePaths(relativePaths);
  }

  // Strategy 3: Fallback — hash all paths together
  return hashProjectId(allPaths.sort().join("|"));
}

/**
 * Detect language from file extensions in extraction data.
 */
function detectLanguage(extraction: StructuredExtraction): string {
  const extCounts = new Map<string, number>();
  for (const f of extraction.modifiedFiles) {
    const ext = path.extname(f.path).toLowerCase();
    if (ext && LANG_MAP[ext]) {
      extCounts.set(LANG_MAP[ext], (extCounts.get(LANG_MAP[ext]) ?? 0) + 1);
    }
  }
  for (const f of extraction.readFiles) {
    const ext = path.extname(f).toLowerCase();
    if (ext && LANG_MAP[ext]) {
      extCounts.set(LANG_MAP[ext], (extCounts.get(LANG_MAP[ext]) ?? 0) + 1);
    }
  }
  if (!extCounts.size) return "unknown";
  return [...extCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Detect framework from file paths.
 */
function detectFramework(extraction: StructuredExtraction): string | null {
  const allPaths = extraction.readFiles.join(" ") + " " + extraction.modifiedFiles.map(f => f.path).join(" ");
  for (const { pattern, framework } of FRAMEWORK_SIGNALS) {
    if (pattern.test(allPaths)) return framework;
  }
  return null;
}

/**
 * Extract key directory patterns from file paths.
 */
function extractKeyDirs(extraction: StructuredExtraction, maxDirs = 8): string[] {
  const dirCounts = new Map<string, number>();
  for (const f of extraction.modifiedFiles) {
    const parts = f.path.split("/");
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join("/");
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
  }
  return [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxDirs)
    .map(([d]) => d);
}

/**
 * Load project fingerprint from cache.
 */
export function loadProjectFingerprint(projectId: string): ProjectFingerprint | null {
  try {
    const fp = getFingerprintPath(projectId);
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, "utf8")) as ProjectFingerprint;
    // Expire after 30 days
    if (Date.now() - data.updatedAt > 30 * 24 * 60 * 60 * 1000) return null;
    return data;
  } catch (e) { log.warn("loadProjectFingerprint failed", e); return null; }
}

/**
 * Save/update project fingerprint after compaction.
 */
export function saveProjectFingerprint(
  projectId: string,
  extraction: StructuredExtraction,
): void {
  try {
    if (!fs.existsSync(FINGERPRINT_DIR)) fs.mkdirSync(FINGERPRINT_DIR, { recursive: true });

    const existing = loadProjectFingerprint(projectId);
    const newKnownFiles = [...new Set([
      ...(existing?.knownFiles ?? []),
      ...extraction.modifiedFiles.map(f => f.path),
      ...extraction.readFiles,
    ])].slice(-50); // Keep last 50 unique files

    const fingerprint: ProjectFingerprint = {
      id: projectId,
      language: existing?.language ?? detectLanguage(extraction),
      framework: existing?.framework ?? detectFramework(extraction),
      keyDirectories: extractKeyDirs(extraction),
      knownFiles: newKnownFiles,
      sessionCount: (existing?.sessionCount ?? 0) + 1,
      updatedAt: Date.now(),
    };

    fs.writeFileSync(getFingerprintPath(projectId), JSON.stringify(fingerprint, null, 2));
  } catch (e) { log.warn("saveProjectFingerprint failed", e); }
}

/**
 * Build a project context string for injection into prompts.
 */
export function buildProjectContext(fingerprint: ProjectFingerprint | null): string {
  if (!fingerprint) return "";
  return [
    "## Project Context (learned from " + fingerprint.sessionCount + " session(s))",
    "Language: " + fingerprint.language,
    fingerprint.framework ? "Framework: " + fingerprint.framework : "",
    fingerprint.keyDirectories.length ? "Key dirs: " + fingerprint.keyDirectories.join(", ") : "",
  ].filter(Boolean).join("\n");
}
