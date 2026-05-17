/**
 * Centralized logger for pi-smart-compact.
 * Respects DEBUG environment variable and adds consistent prefix.
 */

import { LOG_PREFIX } from "../constants.ts";

const DEBUG = process.env.DEBUG?.includes("smart-compact") ?? false;

export function warn(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ?? "";
  console.error(LOG_PREFIX + " " + msg + (detail ? ": " + detail : ""));
}

export function error(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message + "\n" + err.stack : err ?? "";
  console.error(LOG_PREFIX + " " + msg + (detail ? ": " + detail : ""));
}

export function debug(msg: string, ...args: unknown[]): void {
  if (DEBUG) console.error(LOG_PREFIX + " [debug] " + msg, ...args);
}
