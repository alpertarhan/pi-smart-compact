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
import { EXTRACTION_CACHE_PREFIX } from "../constants.ts";

function home(): string {
  return process.env.HOME ?? "/tmp";
}

/** Root pi agent directory (`~/.pi/agent`). */
export function piAgentDir(): string {
  return path.join(home(), ".pi", "agent");
}

/** Shared cache root (`~/.pi/agent/.cache`). */
export function cacheDir(): string {
  return path.join(piAgentDir(), ".cache");
}

/** Smart-compact specific cache root (`~/.pi/agent/.cache/smart-compact`). */
export function smartCompactCacheDir(): string {
  return path.join(cacheDir(), "smart-compact");
}

/** Project fingerprint directory. */
export function projectFingerprintDir(): string {
  return path.join(smartCompactCacheDir(), "projects");
}

/** Compaction state directory. */
export function compactionStateDir(): string {
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

/** Damage reports JSONL log. */
export function damageReportsFile(): string {
  return path.join(smartCompactCacheDir(), "damage-reports.jsonl");
}

/** Extraction cache file for a given session. */
export function extractionCacheFile(sessionId: string): string {
  return path.join(cacheDir(), EXTRACTION_CACHE_PREFIX + sessionId.replace(/[^a-zA-Z0-9-]/g, "_") + ".json");
}

/** Project fingerprint file for a given project id. */
export function projectFingerprintFile(projectId: string): string {
  return path.join(projectFingerprintDir(), projectId + ".json");
}

/** Compaction state file for a given project id. */
export function compactionStateFile(projectId: string): string {
  return path.join(compactionStateDir(), projectId + ".json");
}

/** Remediation hints file — files to re-preserve after a damage event. */
export function remediationHintsFile(projectId: string): string {
  return path.join(smartCompactCacheDir(), "remediation-" + projectId + ".json");
}

/** HTML metrics dashboard file. */
export function metricsDashboardFile(): string {
  return path.join(cacheDir(), "smart-compact-report.html");
}
