/** Opt-in output spill: persist before shortening, and resolve only branch-owned references. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, SessionEntry, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { SecretScrubber } from "../domain/scrub.ts";
import { acquireLock, atomicWriteFile } from "../infra/fs.ts";
import { toolArtifactsDir } from "../infra/paths.ts";
import { isUnresolvedSessionId, resolveSessionId } from "../infra/session-identity.ts";
import type { CompactConfig } from "../types.ts";
import { extractText } from "../utils/extraction.ts";
import { isRecord } from "../utils/type-guards.ts";
import { extractToolPath, isReadOnlyResearchTool, normalizeToolName } from "../domain/tool-semantics.ts";
import * as log from "../utils/logger.ts";

export const ARTIFACT_DETAILS_KEY = "smartCompactArtifact";
export const ARTIFACT_MIN_CHARS = 16_384;
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const ARTIFACT_SESSION_BYTES = 32 * 1024 * 1024;
export const ARTIFACT_SESSION_FILES = 256;
const HEX = /^[a-f0-9]{64}$/;
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export interface ToolArtifact {
  version: 1;
  owner: string;
  hash: string;
  previewHash: string;
  chars: number;
  bytes: number;
  lines: number;
  tool: string;
  source: string;
}
export const artifactId = (artifact: ToolArtifact) => "artifact-" + artifact.hash;

export function parseToolArtifact(value: unknown): ToolArtifact | null {
  if (!isRecord(value) || value.version !== 1
    || ![value.owner, value.hash, value.previewHash].every(item => typeof item === "string" && HEX.test(item))
    || ![value.bytes, value.chars, value.lines].every(item => typeof item === "number" && Number.isSafeInteger(item) && item > 0 && item <= ARTIFACT_MAX_BYTES)
    || typeof value.tool !== "string" || value.tool.length > 80 || typeof value.source !== "string" || value.source.length > 200) return null;
  // SAFETY: version, all hashes, bounded numeric fields and strings were validated above.
  return value as unknown as ToolArtifact;
}

async function privateDirectory(directory: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe artifact directory");
  if (create) await fs.chmod(directory, 0o700);
}
async function artifactDirectory(owner: string, create: boolean): Promise<string> {
  if (!HEX.test(owner)) throw new Error("Invalid artifact scope");
  const root = toolArtifactsDir();
  await privateDirectory(root, create);
  const directory = path.join(root, owner);
  await privateDirectory(directory, create);
  return directory;
}

/** Caller must first prove the reference is reachable from its active branch. */
export async function readToolArtifact(artifact: ToolArtifact): Promise<string> {
  if (!parseToolArtifact(artifact)) throw new Error("Invalid artifact metadata");
  try {
    const directory = await artifactDirectory(artifact.owner, false);
    const file = await fs.open(path.join(directory, artifact.hash + ".txt"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== artifact.bytes || stat.size > ARTIFACT_MAX_BYTES || stat.nlink !== 1) throw new Error("Artifact size changed");
      const buffer = Buffer.alloc(artifact.bytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== artifact.bytes) throw new Error("Artifact grew or shrank during reading");
      const text = buffer.subarray(0, offset).toString("utf8");
      if (text.length !== artifact.chars || digest(text) !== artifact.hash) throw new Error("Artifact digest changed");
      return text;
    } finally { await file.close(); }
  } catch {
    throw new Error("Artifact unavailable or changed; re-run the original read if needed. No substitute content was returned.");
  }
}

async function saveArtifact(artifact: ToolArtifact, text: string, signal?: AbortSignal): Promise<void> {
  const directory = await artifactDirectory(artifact.owner, true);
  const release = await acquireLock(path.join(directory, "quota"));
  try {
    signal?.throwIfAborted();
    const file = path.join(directory, artifact.hash + ".txt");
    try {
      await fs.lstat(file);
      if (await readToolArtifact(artifact) !== text) throw new Error("Artifact collision");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let bytes = 0;
    let count = 0;
    // ponytail: bounded per-session scan (256 files), index only if measured spill latency needs it.
    for (const name of await fs.readdir(directory)) {
      if (!/^[a-f0-9]{64}\.txt$/.test(name)) continue;
      const stat = await fs.lstat(path.join(directory, name));
      bytes += stat.size;
      count++;
    }
    if (count >= ARTIFACT_SESSION_FILES || bytes + artifact.bytes > ARTIFACT_SESSION_BYTES) throw new Error("Artifact quota reached");
    await atomicWriteFile(file, text);
    // Never advertise a reference until the complete, verified file exists.
    await readToolArtifact(artifact);
    signal?.throwIfAborted();
  } finally { release(); }
}

function eligible(event: ToolResultEvent): boolean {
  if (event.isError || !event.content.length || event.content.some(block => block.type !== "text") || Array.isArray(event.details)
    || (event.details !== undefined && event.details !== null && !isRecord(event.details))
    || (isRecord(event.details) && Object.hasOwn(event.details, ARTIFACT_DETAILS_KEY))) return false;
  const tool = normalizeToolName(event.toolName);
  // Read guards derive coverage from the original call/truncation metadata. A
  // preview would grant permission to edit unseen lines, regardless of hook order.
  // Keep these deliveries intact until consumers share a delivery-aware contract.
  if (["read", "read_symbol", "read_enclosing", "smart_context"].includes(tool)
    || !isReadOnlyResearchTool(tool, event.input)) return false;
  return true;
}

/** `retrievable` answers whether the agent can reach `smart_context` to read an offloaded output back. */
export function registerArtifactOffload(pi: ExtensionAPI, config: () => CompactConfig, retrievable: () => boolean): void {
  let generation = 0;
  const invalidate = () => { generation++; };
  pi.on("session_start", invalidate);
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("session_shutdown", invalidate);
  pi.on("tool_result", async (event, ctx) => {
    const startedAt = generation;
    const settings = config();
    if (!settings.artifactOffloadEnabled || !retrievable() || !eligible(event)) return;
    const raw = extractText(event.content);
    if (raw.length < ARTIFACT_MIN_CHARS || Buffer.byteLength(raw, "utf8") > ARTIFACT_MAX_BYTES) return;
    const sessionId = resolveSessionId(ctx);
    if (isUnresolvedSessionId(sessionId)) return;
    const scrubber = new SecretScrubber(settings.scrubSecrets, settings.scrubPii);
    const text = scrubber.scrubText(raw).value;
    const bytes = Buffer.byteLength(text, "utf8");
    if (text.length < ARTIFACT_MIN_CHARS || bytes > ARTIFACT_MAX_BYTES || text.includes("\0")) return;
    const source = scrubber.scrubText(String(extractToolPath(event.input) ?? event.input.url ?? event.input.query ?? event.toolName))
      .value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
    const artifact: ToolArtifact = {
      version: 1, owner: digest(sessionId), hash: digest(text), previewHash: "",
      chars: text.length, bytes, lines: text.split("\n").length, tool: normalizeToolName(event.toolName).slice(0, 80), source
    };
    const preview = `[Archived historical ${artifact.tool} output: ${source}]
${artifact.lines} lines / ${artifact.chars} chars of captured tool-result text (after configured redaction, upstream truncation may already apply).
Use smart_context read id=${artifactId(artifact)} or search(query). Do not infer omitted content from this preview.
--- first excerpt ---
${text.slice(0, 768)}
--- last excerpt ---
${text.slice(-768)}`;
    artifact.previewHash = digest(preview);
    try {
      await saveArtifact(artifact, text, ctx.signal);
      if (startedAt !== generation || resolveSessionId(ctx) !== sessionId) return;
      return { content: [{ type: "text" as const, text: preview }], details: { ...(isRecord(event.details) ? event.details : {}), [ARTIFACT_DETAILS_KEY]: artifact } };
    } catch {
      // Storage failure changes neither tool success/failure nor the original output.
      log.debug("Artifact offload skipped; original tool result retained");
    }
  });
}

export function branchToolArtifacts(branch: readonly SessionEntry[], ownedReferences: ReadonlySet<string>) {
  const edited = new Set(branch.flatMap(entry => entry.type === "context_edit" ? [entry.targetId] : []));
  // Deduplicate stored bytes, not the branch entries that authorize/source them.
  const result = new Map<string, ToolArtifact>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError
      || !isReadOnlyResearchTool(entry.message.toolName, {}) || !isRecord(entry.message.details)
      || (edited.has(entry.id) && !ownedReferences.has(entry.id))) continue;
    const artifact = parseToolArtifact(entry.message.details[ARTIFACT_DETAILS_KEY]);
    // Later tool_result hooks may sanitize/replace content; do not undo their transformation.
    if (!artifact || entry.message.content.some(block => block.type !== "text") || digest(extractText(entry.message.content)) !== artifact.previewHash) continue;
    result.set(entry.id, artifact);
  }
  return result;
}
