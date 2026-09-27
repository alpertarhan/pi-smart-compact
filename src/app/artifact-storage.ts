/**
 * Reference-aware, strictly readonly inventory of the durable tool-output
 * spill store (`~/.pi/agent/smart-compact-artifacts`).
 *
 * Artifact files have no TTL by design: they are evidence for sessions that
 * can outlive every cache. This inventory never deletes anything and never
 * claims deletion safety. It classifies each owner scope against the lineage
 * anchors pi itself maintains:
 *
 *   1. Session headers — every `*.jsonl` under the native sessions root
 *      (resolved through the existing `sessionsDir()` helper) starts with
 *      `{type:"session", id}`; `sha256(id)` is the artifact owner scope.
 *      A session file on disk can always capture new output into its scope.
 *   2. Artifact references — toolResult entries may carry
 *      `details.smartCompactArtifact.owner`; forks copy these entries, so a
 *      descendant session keeps bytes reachable after its ancestor's own
 *      session file is gone.
 *
 * Classification:
 *   live                  — provably reachable through at least one anchor.
 *   unreferenced-in-scan  — no anchor inside the scanned root references it.
 *   unknown               — the scan is incomplete (unreadable, oversized, or
 *                           unsafe session file; missing sessions root; or an
 *                           unreadable owner directory).
 *
 * "unreferenced-in-scan" is NOT "safe to delete": the scan covers the native
 * sessions root only. Session logs an embedder keeps in a custom directory
 * outside that root are undiscoverable, and scan-time absence says nothing
 * about references a live session may write moments later. Age is reported
 * for capacity planning and is never a lifecycle criterion here.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { BACKUP_MAX_AGE_MS, BACKUP_MAX_FILES, SEVEN_DAYS_MS } from "../constants.ts";
import { sessionsDir, toolArtifactsDir } from "../infra/paths.ts";
import { isRecord } from "../utils/type-guards.ts";
import { ARTIFACT_DETAILS_KEY, parseToolArtifact } from "./tool-artifacts.ts";

const OWNER_RE = /^[a-f0-9]{64}$/;
const ARTIFACT_FILE_RE = /^[a-f0-9]{64}\.txt$/;
const SESSION_FILE_RE = /\.jsonl$/;
const READ_CHUNK_BYTES = 1024 * 1024;
/** A single JSONL line holds at most one pre-offload tool result (~2 MiB) plus entry overhead. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_WALK_DEPTH = 4;

export interface ArtifactOwnerStatus {
  owner: string;
  files: number;
  bytes: number;
  oldestMs: number | null;
  newestMs: number | null;
  /** Entries inside the owner directory that are not hex-named regular files (locks, strays). */
  stray: number;
  status: "live" | "unreferenced-in-scan" | "unknown";
  reasons: string[];
}

export interface ArtifactStorageReport {
  root: string;
  rootPresent: boolean;
  rootSafe: boolean;
  sessionsRoot: string;
  sessionsRootPresent: boolean;
  sessionFilesScanned: number;
  sessionFilesUnreadable: string[];
  /** False when any lineage source was missing, unreadable, or unsafe. */
  scanComplete: boolean;
  owners: ArtifactOwnerStatus[];
  foreign: Array<{ name: string; kind: string }>;
  totals: { owners: number; files: number; bytes: number; liveBytes: number; unreferencedBytes: number; unknownBytes: number };
  /** Self-managing retention neighbors, for one coherent status surface. */
  retention: { backupMaxFiles: number; backupMaxAgeDays: number; extractionCachePruneDays: number; artifacts: "no automatic deletion" };
  /** Coverage boundary, stated by the report itself so no consumer can misread it. */
  coverage: "native sessions root only; unreferenced-in-scan is not safe-to-delete";
}

interface LineageSink {
  headerIds: Set<string>;
  referencedOwners: Set<string>;
}

/** Stream one session file line-by-line with bounded memory; throw on anything unreadable. */
async function eachSessionLine(file: string, visit: (line: string) => void): Promise<void> {
  const handle = await fs.open(file, fsConstants.O_RDONLY);
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const emit = () => {
      if (!pending.length) return;
      visit(Buffer.concat(pending).toString("utf8"));
      pending = [];
      pendingBytes = 0;
    };
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      let start = 0;
      for (let at = start; at < bytesRead; at++) {
        if (chunk[at] !== 0x0a) continue;
        pending.push(chunk.subarray(start, at));
        emit();
        start = at + 1;
      }
      pending.push(chunk.subarray(start, bytesRead));
      pendingBytes = pending.reduce((sum, part) => sum + part.length, 0);
      if (pendingBytes > MAX_LINE_BYTES) throw new Error("Session line exceeds scan bound");
    }
    emit();
  } finally {
    await handle.close();
  }
}

async function scanSessionFile(file: string, sink: LineageSink): Promise<void> {
  let first = true;
  await eachSessionLine(file, (line) => {
    if (!line.trim()) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("Session line is not valid JSON");
    }
    if (first && isRecord(entry) && entry.type === "session" && typeof entry.id === "string") sink.headerIds.add(entry.id);
    first = false;
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "toolResult") return;
    const details = entry.message.details;
    if (!isRecord(details) || !Object.hasOwn(details, ARTIFACT_DETAILS_KEY)) return;
    // A present-but-corrupt reference poisons the whole scan: its owner set is unknowable.
    const artifact = parseToolArtifact(details[ARTIFACT_DETAILS_KEY]);
    if (!artifact) throw new Error("Corrupt artifact reference in session file");
    sink.referencedOwners.add(artifact.owner);
  });
}

/** Regular `.jsonl` files under the sessions root; anything unexpected fails the scan. */
async function listSessionFiles(directory: string, depth: number, out: string[]): Promise<void> {
  const dirents = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of dirents) {
    if (SESSION_FILE_RE.test(entry.name)) {
      // A `.jsonl` that is not a regular file (symlink, directory) hides lineage.
      if (!entry.isFile()) throw new Error("Unsafe session file entry");
      out.push(path.join(directory, entry.name));
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || depth >= MAX_SESSION_WALK_DEPTH) continue;
    await listSessionFiles(path.join(directory, entry.name), depth + 1, out);
  }
}

async function inspectOwner(root: string, name: string): Promise<ArtifactOwnerStatus> {
  const directory = path.join(root, name);
  let files = 0;
  let bytes = 0;
  let stray = 0;
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  const dirents = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of dirents) {
    if (!ARTIFACT_FILE_RE.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      stray++;
      continue;
    }
    const stat = await fs.lstat(path.join(directory, entry.name));
    files++;
    bytes += stat.size;
    oldestMs = oldestMs === null ? stat.mtimeMs : Math.min(oldestMs, stat.mtimeMs);
    newestMs = newestMs === null ? stat.mtimeMs : Math.max(newestMs, stat.mtimeMs);
  }
  return { owner: name, files, bytes, oldestMs, newestMs, stray, status: "unknown", reasons: [] };
}

/** Readonly, reference-aware inventory of the artifact store and its lineage anchors. */
export async function inspectArtifactStorage(): Promise<ArtifactStorageReport> {
  const root = toolArtifactsDir();
  const sessionsRoot = sessionsDir();
  const sink: LineageSink = { headerIds: new Set(), referencedOwners: new Set() };
  const sessionFilesUnreadable: string[] = [];
  let sessionFilesScanned = 0;
  let sessionsRootPresent = false;
  try {
    const stat = await fs.lstat(sessionsRoot);
    sessionsRootPresent = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    /* absent sessions root */
  }
  // A missing sessions root is an inconsistent state (artifacts without any
  // lineage surface), not proof of absence: everything stays unknown.
  let scanComplete = sessionsRootPresent;
  if (sessionsRootPresent) {
    let files: string[] = [];
    try {
      await listSessionFiles(sessionsRoot, 0, (files = []));
    } catch {
      files = [];
      scanComplete = false;
      sessionFilesUnreadable.push(sessionsRoot);
    }
    files.sort();
    for (const file of files) {
      try {
        await scanSessionFile(file, sink);
        sessionFilesScanned++;
      } catch {
        sessionFilesUnreadable.push(file);
        scanComplete = false;
      }
    }
  }
  const liveFromIds = new Set(Array.from(sink.headerIds, id => createHash("sha256").update(id).digest("hex")));

  let rootPresent = false;
  let rootSafe = false;
  const owners: ArtifactOwnerStatus[] = [];
  const foreign: Array<{ name: string; kind: string }> = [];
  try {
    const stat = await fs.lstat(root);
    rootPresent = true;
    rootSafe = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    /* absent artifact root: nothing stored */
  }
  if (rootSafe) {
    const dirents = (await fs.readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of dirents) {
      if (!OWNER_RE.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
        foreign.push({ name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" });
        continue;
      }
      try {
        owners.push(await inspectOwner(root, entry.name));
      } catch {
        owners.push({ owner: entry.name, files: 0, bytes: 0, oldestMs: null, newestMs: null, stray: 0, status: "unknown", reasons: ["unreadable"] });
      }
    }
  }
  let liveBytes = 0;
  let unreferencedBytes = 0;
  let unknownBytes = 0;
  for (const owner of owners) {
    if (!owner.reasons.includes("unreadable")) {
      const reasons: string[] = [];
      if (liveFromIds.has(owner.owner)) reasons.push("session-file");
      if (sink.referencedOwners.has(owner.owner)) reasons.push("artifact-reference");
      if (reasons.length) owner.status = "live";
      else if (scanComplete) owner.status = "unreferenced-in-scan";
      else reasons.push("scan-incomplete");
      owner.reasons = reasons;
    }
    if (owner.status === "live") liveBytes += owner.bytes;
    else if (owner.status === "unreferenced-in-scan") unreferencedBytes += owner.bytes;
    else unknownBytes += owner.bytes;
  }
  const totalBytes = liveBytes + unreferencedBytes + unknownBytes;
  return {
    root, rootPresent, rootSafe, sessionsRoot, sessionsRootPresent, sessionFilesScanned, sessionFilesUnreadable, scanComplete,
    owners, foreign,
    totals: { owners: owners.length, files: owners.reduce((sum, owner) => sum + owner.files, 0), bytes: totalBytes, liveBytes, unreferencedBytes, unknownBytes },
    retention: {
      backupMaxFiles: BACKUP_MAX_FILES,
      backupMaxAgeDays: BACKUP_MAX_AGE_MS / (24 * 60 * 60 * 1000),
      extractionCachePruneDays: SEVEN_DAYS_MS / (24 * 60 * 60 * 1000),
      artifacts: "no automatic deletion",
    },
    coverage: "native sessions root only; unreferenced-in-scan is not safe-to-delete",
  };
}
