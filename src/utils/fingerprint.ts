/**
 * Lightweight project fingerprint for cross-session context.
 * Stores basic project metadata to improve compaction accuracy.
 */

import fs from "node:fs";
import path from "node:path";
import type { StructuredExtraction } from "../types.ts";

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
 * Generate a project ID from file paths in the extraction.
 * Uses the most common root directory as a heuristic.
 */
export function deriveProjectId(extraction: StructuredExtraction): string {
  const allPaths = [
    ...extraction.modifiedFiles.map(f => f.path),
    ...extraction.readFiles,
  ];
  if (!allPaths.length) return "unknown";

  // Find most common root directory
  const roots = new Map<string, number>();
  for (const p of allPaths) {
    const parts = p.split("/");
    const root = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join("/") : "root";
    roots.set(root, (roots.get(root) ?? 0) + 1);
  }
  const topRoot = [...roots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
  // Simple hash of the root
  let hash = 0;
  for (let i = 0; i < topRoot.length; i++) {
    hash = ((hash << 5) - hash + topRoot.charCodeAt(i)) | 0;
  }
  return "proj-" + Math.abs(hash).toString(36);
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
  } catch { return null; }
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
  } catch { /* best effort */ }
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
