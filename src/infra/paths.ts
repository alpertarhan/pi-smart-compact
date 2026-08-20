/**
 * Centralized filesystem path resolution.
 *
 * Every disk-bound subsystem in the extension (extraction cache, metrics log,
 * project fingerprints, compaction state, damage reports, backups, session
 * logs) used to compute its own `path.join(process.env.HOME …)` on every call.
 * That made it impossible to:
 *
 *  - test path layout deterministically (HOME changes per test, but module
 *    state captured an old HOME),
 *  - swap roots in worktree / CI scenarios,
 *  - reason about file ownership when adding atomic writes and locking.
 *
 * This module is intentionally **stateless**: every function reads
 * `process.env.HOME` at call time. That way tests can override HOME in
 * `beforeEach` and the next call sees the new root.
 */

import path from "node:path";
import os from "node:os";
import { EXTRACTION_CACHE_PREFIX } from "../constants.ts";

/**
 * `HOME` wins so tests can override the root. Windows' `USERPROFILE` is the
 * next choice; GUI launches that strip both variables fall back to
 * `os.homedir()`, matching how the pi host resolves `~/.pi/agent`.
 */
export function home(): string {
 const configured = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
 return configured || os.homedir();
}

/** Root pi agent directory (`~/.pi/agent`). */
export function piAgentDir(): string {
 return path.join(home(), ".pi", "agent");
}

/** Shared cache root (`~/.pi/agent/.cache`). */
function cacheDir(): string {
 return path.join(piAgentDir(), ".cache");
}

/** Smart-compact specific cache root (`~/.pi/agent/.cache/smart-compact`). */
function smartCompactCacheDir(): string {
 return path.join(cacheDir(), "smart-compact");
}

/** Project fingerprint directory. */
function projectFingerprintDir(): string {
 return path.join(smartCompactCacheDir(), "projects");
}

/** Compaction state directory. */
function compactionStateDir(): string {
 return path.join(smartCompactCacheDir(), "states");
}

/** Pi-coding-agent session log directory. */
export function sessionsDir(): string {
 return path.join(piAgentDir(), "sessions");
}

/** Pi-coding-agent settings file. */
export function settingsFile(): string {
 return path.join(piAgentDir(), "settings.json");
}

/** Default backup directory. */
export function defaultBackupDir(): string {
 return path.join(piAgentDir(), "compact-backups");
}

/** Metrics JSONL log. */
export function metricsLogFile(): string {
 return path.join(cacheDir(), "compact-metrics.jsonl");
}

/** Cross-process Smart Compact semaphore/session lease directory. */
export function runLocksDir(): string {
 return path.join(smartCompactCacheDir(), "run-locks");
}

/** One-shot, branch-scoped native-compaction continuity handoffs. */
export function nativeContinuityDir(): string {
 return path.join(smartCompactCacheDir(), "native-continuity");
}

/** Project-scoped persistent context graph (SQLite + FTS5). */
export function contextGraphFile(): string {
 return path.join(smartCompactCacheDir(), "context-graph.sqlite");
}

/** Damage reports JSONL log. */
export function damageReportsFile(): string {
 return path.join(smartCompactCacheDir(), "damage-reports.jsonl");
}

/** Extraction cache file for a given session. */
export function extractionCacheFile(sessionId: string): string {
 return path.join(
  cacheDir(),
  EXTRACTION_CACHE_PREFIX + sessionId.replace(/[^a-zA-Z0-9-]/g, "_") + ".json",
 );
}

/** Project fingerprint file for a given project id. */
export function projectFingerprintFile(projectId: string): string {
 return path.join(projectFingerprintDir(), projectId + ".json");
}

/** Legacy project-wide compaction state file (v1). */
export function compactionStateFile(projectId: string): string {
 return path.join(
  compactionStateDir(),
  projectId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json",
 );
}

/** Pre-v8.1 session-only path, retained solely for one-time branch migration. */
export function legacyScopedCompactionStateFile(
 projectId: string,
 sessionId: string,
): string {
 const project = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
 const session = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
 return path.join(compactionStateDir(), project, session + ".json");
}

/** Immutable branch snapshot; descendants find it through their ancestry IDs. */
export function scopedCompactionStateFile(
 projectId: string,
 sessionId: string,
 branchHeadId: string,
): string {
 const project = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
 const session = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
 const branch = branchHeadId.replace(/[^a-zA-Z0-9_-]/g, "_");
 return path.join(compactionStateDir(), project, session, branch + ".json");
}

/** Remediation hints file — files to re-preserve after a damage event. */
export function remediationHintsFile(projectId: string): string {
 return path.join(smartCompactCacheDir(), "remediation-" + projectId + ".json");
}

/** HTML metrics dashboard file. */
export function metricsDashboardFile(): string {
 return path.join(cacheDir(), "smart-compact-report.html");
}
