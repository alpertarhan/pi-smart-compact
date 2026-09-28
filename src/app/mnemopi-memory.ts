import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import type { CompactConfig } from "../types.ts";
import { home, piAgentDir } from "../infra/paths.ts";
import { acquireLock, ensureDir } from "../infra/fs.ts";
import { mnemopiTargetDigest } from "../infra/memory-ref.ts";
import { installCommand } from "../infra/optional-components.ts";
import {
  type BunExecutable,
  resolveBunExecutable,
} from "./memory-backend.ts";
import {
  MNEMOPI_READY,
  MnemopiOutcomeSchema,
  type MnemopiOutcome,
  type MnemopiRequest,
} from "./mnemopi-protocol.ts";

export function mnemopiTarget(config: Pick<CompactConfig, "mnemopiDataDir">, projectId: string): { dbPath: string; projectId: string } {
  const configured = config.mnemopiDataDir;
  const directory = configured?.startsWith("~/")
    ? path.join(home(), configured.slice(2))
    : configured ?? path.join(piAgentDir(), "smart-compact-memory", "mnemopi");
  return { projectId, dbPath: path.join(directory, projectId, "memory.sqlite") };
}

/** The Bun-only optional engine never loads into stock Pi's Node process. */
export async function runMnemopi(
  request: MnemopiRequest,
  signal?: AbortSignal,
  options?: { bunExecutable?: BunExecutable | null },
): Promise<MnemopiOutcome> {
  if (signal?.aborted) return { state: "failed", reason: "Cancelled before starting Mnemopi; nothing changed" };
  if (request.operation !== "save" && request.operation !== "recall" && !existsSync(request.dbPath)) {
    if (request.operation === "inspect") return { state: "inspected", dbPath: request.dbPath, fact: null };
    return { state: "resolved", dbPath: request.dbPath, closed: false };
  }
  const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./mnemopi-worker.ts" : "./mnemopi-worker.js", import.meta.url));
  const { promise, resolve } = Promise.withResolvers<MnemopiOutcome>();
  let release: (() => void) | undefined;
  let closed = false;
  let submitted = false;
  let ready = false;
  let preamble = "";
  const bun = options && "bunExecutable" in options ? options.bunExecutable : resolveBunExecutable();
  const child = execFile(bun?.executable ?? "bun", ["--no-install", worker], {
    signal, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024, encoding: "utf8",
  }, (error, stdout) => {
    if (!error) {
      try {
        const outcome: unknown = JSON.parse(stdout.slice(MNEMOPI_READY.length + 1));
        if (Check(MnemopiOutcomeSchema, outcome)) { resolve(outcome); return; }
      } catch { /* A partial worker response cannot prove whether a mutation committed. */ }
    }
    if (error?.code === "ENOENT") {
      resolve({ state: "failed", reason: "Mnemopi needs Bun >=1.3.14 on PATH or the optional bun component (install it with: " + installCommand(["bun"]) + "); no memory was changed" });
      return;
    }
    resolve({
      state: request.operation === "recall" || !submitted ? "failed" : "unknown",
      reason: "Mnemopi worker did not complete. Check Bun >=1.3.14 and the optional @oh-my-pi/pi-mnemopi component (" + installCommand(["mnemopi"]) + "). " +
        (!submitted ? "No memory request was sent." : request.operation === "recall" ? "Recall unavailable." : "Write outcome unknown; repeating the same fact is idempotent."),
      dbPath: request.dbPath,
    });
  });
  child.once("close", () => { closed = true; release?.(); });
  child.stdout?.on("data", async (chunk: string) => {
    if (ready) return;
    preamble += chunk;
    if (!preamble.includes("\n")) return;
    if (!preamble.startsWith(MNEMOPI_READY + "\n")) { child.kill("SIGKILL"); return; }
    ready = true;
    try {
      if (closed || signal?.aborted) return;
      if (request.operation !== "recall") {
        ensureDir(path.dirname(request.dbPath));
        release = await acquireLock(request.dbPath);
      }
      if (closed || signal?.aborted) { release?.(); return; }
      // Content stays out of argv. Hold the existing cross-process lock until exit,
      // not just the abort callback: an interrupted child may still be writing.
      submitted = true;
      child.stdin?.end(JSON.stringify(request));
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      resolve({
        state: "failed",
        reason: /lock/i.test(cause)
          ? "No memory request was sent: the memory database lock stayed busy for " + request.dbPath
          : "No memory request was sent: " + cause,
        dbPath: request.dbPath,
      });
      child.kill("SIGKILL");
    }
  });
  child.stdin?.on("error", () => { /* execFile reports an exited or interrupted worker. */ });
  return promise;
}

const CONTENTION_PATTERN = /lock|busy|recover|sqlite_busy/i;

/** Contention guidance appended to lock/recovery failures; never auto-removes a lock. */
function contentionNote(outcome: Extract<MnemopiOutcome, { state: "failed" | "unknown" }>): string {
  if (!CONTENTION_PATTERN.test(outcome.reason)) return "";
  return (
    "\nCause: the memory database is locked, busy, or recovering — most likely another " +
    "session is writing it, or a crashed run left the lock behind. Nothing was changed " +
    "and the lock was NOT removed automatically." +
    (outcome.dbPath
      ? " After verifying no other session is running, remove " + outcome.dbPath + ".lock manually to recover."
      : "")
  );
}

export function formatMnemopiOutcome(outcome: MnemopiOutcome): string {
  switch (outcome.state) {
    case "saved": return outcome.existing
      ? "Mnemopi: fact already saved (ref mnemopi:" + outcome.memoryId + "@" + mnemopiTargetDigest(outcome.dbPath) + "); original title and paths unchanged."
      : "Mnemopi: saved project memory (ref mnemopi:" + outcome.memoryId + "@" + mnemopiTargetDigest(outcome.dbPath) + ").";
    case "resolved": return outcome.closed ? "Mnemopi: resolved the saved fact." : "Mnemopi: no matching active fact; nothing changed.";
    case "inspected": return outcome.fact
      ? "Mnemopi: found the saved fact (" + outcome.fact.kind + ") " + outcome.fact.title
      : "Mnemopi: no matching active fact.";
    case "failed": return "Mnemopi FAILED: " + outcome.reason + contentionNote(outcome);
    case "unknown": return "Mnemopi UNKNOWN: " + outcome.reason + contentionNote(outcome);
    case "recalled": {
      const lines = ["Mnemopi Recall — untrusted project memory (local full-text search)"];
      let remaining = 6_000 - lines[0].length;
      for (const fact of outcome.facts) {
        if (remaining <= 1) break;
        const text = "\n[" + fact.kind + "] " + fact.title + "\nRef: mnemopi:" + fact.memoryId +
          "@" + mnemopiTargetDigest(outcome.dbPath) + "\n" + fact.content;
        if (text.length > remaining) { lines.push(text.slice(0, remaining - 1) + "…"); break; }
        lines.push(text);
        remaining -= text.length;
      }
      if (!outcome.facts.length) lines.push("\nNo matching project memories.");
      return lines.join("");
    }
  }
}
