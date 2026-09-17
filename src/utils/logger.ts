/**
 * Centralized logger for pi-smart-compact.
 * Respects DEBUG environment variable and adds consistent prefix.
 */

import { LOG_PREFIX } from "../constants.ts";

const DEBUG = process.env.DEBUG?.includes("smart-compact") ?? false;

/** Wall-clock stamp so debug logs can be correlated with long-running calls. */
function ts(): string {
  return new Date().toISOString();
}

export function warn(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ?? "";
  console.error(ts() + " " + LOG_PREFIX + " " + msg + (detail ? ": " + detail : ""));
}

function error(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message + "\n" + err.stack : err ?? "";
  console.error(ts() + " " + LOG_PREFIX + " " + msg + (detail ? ": " + detail : ""));
}

export function info(msg: string, ...args: unknown[]): void {
  console.error(ts() + " " + LOG_PREFIX + " [info] " + msg, ...args);
}

export function debug(msg: string, ...args: unknown[]): void {
  if (DEBUG) console.error(ts() + " " + LOG_PREFIX + " [debug] " + msg, ...args);
}

export function debugError(msg: string, err?: unknown): void {
  if (DEBUG) error(msg, err);
}
