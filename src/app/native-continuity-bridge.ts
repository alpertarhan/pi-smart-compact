import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ONE_HOUR_MS, SEVEN_DAYS_MS } from "../constants.ts";
import { acquireLockSync, atomicWriteFileSync, ensureDir } from "../infra/fs.ts";
import { nativeContinuityDir } from "../infra/paths.ts";
import * as log from "../utils/logger.ts";

const MAX_TEXT_BYTES = 256 * 1024;

export interface NativeContinuityScope {
  projectId: string;
  sessionId: string;
  branchHeadId: string;
}

interface Entry {
  schemaVersion: 1;
  scope: NativeContinuityScope;
  text: string;
  createdAt: number;
}

export interface NativeContinuityBridge {
  stage(scope: NativeContinuityScope, text: string): void;
  take(scope: NativeContinuityScope): string | null;
  clear(scope?: NativeContinuityScope): void;
  size(): number;
}

function sameScope(a: NativeContinuityScope, b: NativeContinuityScope): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId && a.branchHeadId === b.branchHeadId;
}

function boundedContinuityText(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_TEXT_BYTES) return text;
  const marker = Buffer.from("\n… [continuity truncated from " + bytes.length + " bytes]\n");
  let end = Math.max(0, MAX_TEXT_BYTES - marker.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return Buffer.concat([bytes.subarray(0, end), marker]).toString("utf8");
}

export function createNativeContinuityBridge(opts: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  dir?: string;
} = {}): NativeContinuityBridge {
  const ttlMs = Math.max(1, opts.ttlMs ?? SEVEN_DAYS_MS);
  const maxEntries = Math.max(1, opts.maxEntries ?? 64);
  const now = opts.now ?? Date.now;
  const dir = opts.dir ?? nativeContinuityDir();
  const lockTarget = path.join(dir, "bridge");
  const fileFor = (scope: NativeContinuityScope) => path.join(
    dir,
    crypto.createHash("sha256").update(scope.projectId + "\0" + scope.sessionId + "\0" + scope.branchHeadId).digest("hex") + ".json",
  );
  const validScope = (scope: NativeContinuityScope) => Boolean(scope.projectId && scope.sessionId && scope.branchHeadId);

  const readEntry = (file: string): Entry | null => {
    try {
      if (fs.statSync(file).size > MAX_TEXT_BYTES * 2) return null;
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Entry>;
      if (value.schemaVersion !== 1 || typeof value.text !== "string"
        || Buffer.byteLength(value.text) > MAX_TEXT_BYTES || typeof value.createdAt !== "number"
        || !Number.isFinite(value.createdAt) || !value.scope || !validScope(value.scope)) return null;
      return value as Entry;
    } catch { return null; }
  };

  const prune = (reserve: number): Array<{ file: string; entry: Entry }> => {
    const fresh: Array<{ file: string; entry: Entry }> = [];
    let names: string[] = [];
    try { names = fs.readdirSync(dir); }
    catch { return fresh; }
    for (const name of names) {
      if (!/\.tmp\.\d+\.[0-9a-f]+$/i.test(name)) continue;
      const file = path.join(dir, name);
      try { if (now() - fs.statSync(file).mtimeMs > ONE_HOUR_MS) fs.unlinkSync(file); } catch { /* another process won */ }
    }
    const files = names.filter(file => file.endsWith(".json"));
    for (const name of files) {
      const file = path.join(dir, name);
      const entry = readEntry(file);
      if (!entry || now() - entry.createdAt > ttlMs || entry.createdAt - now() > ttlMs) {
        try { fs.unlinkSync(file); } catch { /* another process won */ }
      } else {
        fresh.push({ file, entry });
      }
    }
    fresh.sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.file.localeCompare(b.file));
    while (fresh.length > Math.max(0, maxEntries - reserve)) {
      const oldest = fresh.shift();
      if (oldest) try { fs.unlinkSync(oldest.file); } catch { /* another process won */ }
    }
    return fresh;
  };

  const locked = <T>(work: () => T): T => {
    ensureDir(dir);
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const release = acquireLockSync(lockTarget);
    try { return work(); }
    finally { release(); }
  };

  return {
    stage(scope, text) {
      if (!validScope(scope) || !text.trim()) return;
      const boundedText = boundedContinuityText(text);
      try {
        locked(() => {
          const target = fileFor(scope);
          try { fs.unlinkSync(target); } catch { /* replace or absent */ }
          prune(1);
          const entry: Entry = { schemaVersion: 1, scope, text: boundedText, createdAt: now() };
          atomicWriteFileSync(target, JSON.stringify(entry));
          try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
        });
      } catch (error) { log.debug("native continuity stage failed", error); }
    },
    take(scope) {
      if (!validScope(scope)) return null;
      try {
        return locked(() => {
          prune(0);
          const target = fileFor(scope);
          const entry = readEntry(target);
          if (!entry) return null;
          try { fs.unlinkSync(target); } catch { return null; }
          return sameScope(entry.scope, scope) && now() - entry.createdAt <= ttlMs ? entry.text : null;
        });
      } catch (error) {
        log.debug("native continuity take failed", error);
        return null;
      }
    },
    clear(scope) {
      try {
        locked(() => {
          if (scope) {
            try { fs.unlinkSync(fileFor(scope)); } catch { /* absent */ }
            return;
          }
          for (const item of prune(0)) {
            try { fs.unlinkSync(item.file); } catch { /* another process won */ }
          }
        });
      } catch (error) { log.debug("native continuity clear failed", error); }
    },
    size() {
      try { return locked(() => prune(0).length); }
      catch (error) { log.debug("native continuity size failed", error); return 0; }
    },
  };
}
