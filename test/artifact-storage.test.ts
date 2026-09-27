/**
 * Reference-aware, strictly readonly artifact-storage inventory.
 *
 * Liveness comes from pi's own durable lineage: session headers
 * (`sha256(id)` is the owner scope) and `smartCompactArtifact` references in
 * session logs, which forks inherit. Anything unreadable, unsafe, or absent
 * keeps owners "unknown". "unreferenced-in-scan" is a capacity observation,
 * never a safe-to-delete claim: the scan covers the native sessions root
 * only, and nothing in this module deletes anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolArtifactsDir } from "../src/infra/paths.ts";
import { inspectArtifactStorage } from "../src/app/artifact-storage.ts";

const previousHome = process.env.HOME;
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "psc-artifact-storage-")); process.env.HOME = home; });
afterEach(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; fs.rmSync(home, { recursive: true, force: true }); });

const hex = (value: number, fill = "0") => value.toString(16).padStart(64, fill);
const ownerOf = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex");

/** Minimal native session log with an optional artifact reference, as the offload hook writes it. */
function writeSessionFile(sessionId: string, referencedOwners: string[], parent?: string): string {
  const dir = path.join(home, ".pi", "agent", "sessions", "--proj--");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}_${sessionId}.jsonl`);
  const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: home, ...(parent ? { parentSession: parent } : {}) })];
  referencedOwners.forEach((owner, index) => {
    lines.push(JSON.stringify({ type: "message", id: "e" + index, parentId: index ? "e" + (index - 1) : null, timestamp: new Date().toISOString(),
      message: { role: "toolResult", toolCallId: "c" + index, toolName: "grep", content: [{ type: "text", text: "preview" }], isError: false,
        details: { smartCompactArtifact: { version: 1, owner, hash: hex(index + 1), previewHash: hex(index + 50), chars: 8, bytes: 8, lines: 1, tool: "grep", source: "src/x.ts" } } } }));
  });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function writeArtifactFiles(owner: string, sizes: number[]): string[] {
  const dir = path.join(toolArtifactsDir(), owner);
  fs.mkdirSync(dir, { recursive: true });
  return sizes.map((size, index) => {
    const file = path.join(dir, hex(index + 1) + ".txt");
    fs.writeFileSync(file, "x".repeat(size));
    return file;
  });
}

describe("artifact storage inventory", () => {
  it("classifies owners from session headers and artifact references, unreferenced only on complete scans", async () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const referenced = hex(0xa1, "a");
    writeSessionFile(sessionId, [referenced]);
    writeArtifactFiles(ownerOf(sessionId), [10, 20]);
    writeArtifactFiles(referenced, [30]);
    const unreferenced = hex(0xd1, "d");
    writeArtifactFiles(unreferenced, [40, 50]);
    const report = await inspectArtifactStorage();
    expect(report.scanComplete).toBe(true);
    expect(report.sessionFilesScanned).toBe(1);
    expect(report.rootSafe).toBe(true);
    expect(report.coverage).toBe("native sessions root only; unreferenced-in-scan is not safe-to-delete");
    const by = (owner: string) => report.owners.find(item => item.owner === owner);
    expect(by(ownerOf(sessionId))).toMatchObject({ status: "live", reasons: ["session-file"], files: 2, bytes: 30 });
    expect(by(referenced)).toMatchObject({ status: "live", reasons: ["artifact-reference"], files: 1, bytes: 30 });
    expect(by(unreferenced)).toMatchObject({ status: "unreferenced-in-scan", reasons: [], files: 2, bytes: 90 });
    expect(report.totals).toMatchObject({ owners: 3, files: 5, bytes: 150, liveBytes: 60, unreferencedBytes: 90, unknownBytes: 0 });
    expect(report.retention).toMatchObject({ backupMaxFiles: 20, backupMaxAgeDays: 14, extractionCachePruneDays: 7, artifacts: "no automatic deletion" });
    // Readonly: every byte inspected is still on disk afterwards.
    expect(report.owners.every(owner => fs.existsSync(path.join(report.root, owner.owner)))).toBe(true);
  });

  it("keeps fork-referenced bytes live after the original session file is deleted", async () => {
    const originalId = "22222222-2222-2222-2222-222222222222";
    const forkId = "33333333-3333-3333-3333-333333333333";
    const owner = hex(0xb1, "b");
    const original = writeSessionFile(originalId, [owner]);
    writeSessionFile(forkId, [owner], original);
    writeArtifactFiles(owner, [30]);
    writeArtifactFiles(ownerOf(originalId), [5]);
    fs.rmSync(original);
    const report = await inspectArtifactStorage();
    const by = (candidate: string) => report.owners.find(item => item.owner === candidate);
    expect(by(owner)).toMatchObject({ status: "live", reasons: ["artifact-reference"] });
    expect(by(ownerOf(originalId))).toMatchObject({ status: "unreferenced-in-scan" });
  });

  it.each(["permission", "garbage-line", "oversize-line", "symlinked-file"])("poisons the scan on %s so nothing can be classified unreferenced", async (kind) => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const referenced = hex(0xc1, "c");
    const file = writeSessionFile(sessionId, [referenced]);
    if (kind === "permission") fs.chmodSync(file, 0o000);
    if (kind === "garbage-line") fs.appendFileSync(file, "{not json\n");
    if (kind === "oversize-line") fs.appendFileSync(file, '{"pad":"' + "x".repeat(9 * 1024 * 1024) + '"}\n');
    if (kind === "symlinked-file") {
      fs.rmSync(file);
      fs.symlinkSync(writeSessionFile("55555555-5555-5555-5555-555555555555", []), file);
    }
    const unreferenced = hex(0xd2, "d");
    writeArtifactFiles(unreferenced, [40]);
    const report = await inspectArtifactStorage();
    expect(report.scanComplete).toBe(false);
    expect(report.sessionFilesUnreadable.length).toBeGreaterThanOrEqual(1);
    expect(report.owners.every(item => item.status !== "unreferenced-in-scan")).toBe(true);
    expect(fs.existsSync(path.join(toolArtifactsDir(), unreferenced, hex(1) + ".txt"))).toBe(true);
    if (kind === "permission") fs.chmodSync(file, 0o644);
  });

  it("treats a missing sessions root as unprovable, not as proof of absence", async () => {
    const owner = hex(0xd3, "d");
    writeArtifactFiles(owner, [40]);
    const report = await inspectArtifactStorage();
    expect(report.sessionsRootPresent).toBe(false);
    expect(report.scanComplete).toBe(false);
    expect(report.owners[0]).toMatchObject({ status: "unknown", reasons: ["scan-incomplete"] });
    expect(report.totals).toMatchObject({ unreferencedBytes: 0, unknownBytes: 40 });
  });

  it("reports foreign root entries and an unsafe root without touching either", async () => {
    const owner = hex(0xe1, "e");
    writeArtifactFiles(owner, [10]);
    const root = toolArtifactsDir();
    fs.writeFileSync(path.join(root, "readme.txt"), "note");
    fs.writeFileSync(path.join(root, hex(0)), "hex-named file, not a directory");
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel"), "keep");
    fs.symlinkSync(outside, path.join(root, hex(1)));
    const report = await inspectArtifactStorage();
    expect(report.owners).toHaveLength(1);
    expect(report.foreign.map(entry => entry.name).sort()).toEqual([hex(0), hex(1), "readme.txt"].sort());
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(root, "readme.txt"), "utf8")).toBe("note");

    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "not a directory");
    const unsafe = await inspectArtifactStorage();
    expect(unsafe.rootPresent).toBe(true);
    expect(unsafe.rootSafe).toBe(false);
    expect(unsafe.owners).toHaveLength(0);
  });

  it("marks an unreadable owner directory unknown", async () => {
    const sessionId = "66666666-6666-6666-6666-666666666666";
    writeSessionFile(sessionId, []);
    const owner = ownerOf(sessionId);
    const files = writeArtifactFiles(owner, [10]);
    fs.chmodSync(path.dirname(files[0]), 0o000);
    const report = await inspectArtifactStorage();
    expect(report.owners[0]).toMatchObject({ status: "unknown", reasons: ["unreadable"] });
    fs.chmodSync(path.dirname(files[0]), 0o755);
  });

  it("reports age bounds for capacity planning without any deletion semantics", async () => {
    const sessionId = "77777777-7777-7777-7777-777777777777";
    writeSessionFile(sessionId, []);
    const files = writeArtifactFiles(ownerOf(sessionId), [10, 20]);
    const aged = (Date.now() - 21 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(files[0], aged, aged);
    const report = await inspectArtifactStorage();
    const owner = report.owners.find(item => item.owner === ownerOf(sessionId))!;
    expect(owner.status).toBe("live");
    expect(Math.round((Date.now() - owner.oldestMs!) / 86400000)).toBe(21);
    expect(owner.newestMs!).toBeGreaterThan(owner.oldestMs!);
    expect(fs.existsSync(files[0])).toBe(true);
  });
});
