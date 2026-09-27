/** One bounded retrieval surface for native-history references, visual excerpts, and spill files. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SecretScrubber } from "../domain/scrub.ts";
import { extractToolPath } from "../domain/tool-semantics.ts";
import { extractText } from "../utils/extraction.ts";
import { inspectContext, readContextReference } from "./context-operations.ts";
import type { LineageSession } from "./session-lineage.ts";
import { activeVisualArchive } from "./visual-archive.ts";
import { artifactId, branchToolArtifacts, readToolArtifact, type ToolArtifact } from "./tool-artifacts.ts";
import type { VisualArchive } from "../types.ts";

export const MAX_SEARCH_SOURCES = 32;
export const MAX_SEARCH_CHARS = 4 * 1024 * 1024;
export const MAX_READ_CHARS = 4_096;

interface EvidenceSource {
  id: string;
  kind: "session-output" | "visual-excerpt" | "tool-artifact";
  tool: string;
  source: string;
  chars: number;
  /** Session outputs only: whether a SHA-256 was recorded at archive time (checked on read/search). */
  hashed?: boolean;
  /** Parent-session sources only (`scope=lineage`): owning session id and handoff/fork depth. */
  session?: string;
  depth?: number;
}

/** One branch's sources; `owns` claims an id and `read` authorizes it by that branch and session only. */
interface BranchEvidence {
  state: ReturnType<typeof inspectContext>;
  list: EvidenceSource[];
  owns(id: string): boolean;
  read(id: string): Promise<string>;
}

function branchEvidence(branch: SessionEntry[], sessionId: string, scrubber: SecretScrubber, visual?: VisualArchive["sources"]): BranchEvidence {
  const state = inspectContext(branch, sessionId);
  const artifacts = branchToolArtifacts(branch, state.references);
  const payloads = new Map<string, ToolArtifact>();
  const entries = new Map(branch.map(entry => [entry.id, entry]));
  const calls = new Map<string, string>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall") continue;
      const value = extractToolPath(block.arguments) ?? block.arguments.url ?? block.arguments.query;
      if (typeof value === "string") calls.set(block.id, scrubber.scrubText(value).value.slice(0, 200));
    }
  }
  const records = new Map<string, EvidenceSource>();
  for (const id of state.references) {
    if (artifacts.has(id)) continue; // list the source, not its archived preview too
    const entry = entries.get(id);
    if (entry?.type !== "message" || entry.message.role !== "toolResult") continue;
    records.set(id, { id, kind: "session-output", tool: entry.message.toolName,
      source: calls.get(entry.message.toolCallId) ?? entry.message.toolName, chars: extractText(entry.message.content).length,
      hashed: state.archives.has(id) });
  }
  for (const source of visual ?? []) {
    records.set(source.id, { id: source.id, kind: "visual-excerpt", tool: "historical-read", source: "Bounded visual excerpt", chars: source.text.length });
  }
  for (const artifact of artifacts.values()) {
    const id = artifactId(artifact);
    payloads.set(id, artifact); // Existing content IDs remain valid read aliases.
    const source = scrubber.scrubText(artifact.source).value;
    const key = JSON.stringify([id, artifact.tool, source]);
    // Keep every distinct provenance, but repeated identical observations add no noise.
    records.delete(key);
    records.set(key, { id, kind: "tool-artifact", tool: artifact.tool, source, chars: artifact.chars });
  }
  const owns = (id: string) => artifacts.has(id) || payloads.has(id) || state.references.has(id) || Boolean(visual?.some(item => item.id === id));
  const read = async (id: string): Promise<string> => {
    const artifact = artifacts.get(id) ?? payloads.get(id);
    const source = visual?.find(item => item.id === id);
    const text = artifact ? await readToolArtifact(artifact) : source?.text ?? readContextReference(branch, sessionId, id);
    // All representations are redacted in full before matching or paging.
    return scrubber.scrubText(text).value;
  };
  return { state, list: [...records.values()].reverse(), owns, read };
}

/**
 * Active-branch evidence, then (with `lineage`, nearest-first) parent-session outputs and artifacts.
 * An id resolves in the nearest scope that owns it; visual excerpts stay active-branch only.
 */
export function contextEvidence(branch: SessionEntry[], sessionId: string, scrubber: SecretScrubber, lineage: readonly LineageSession[] = []) {
  const visual = activeVisualArchive(branch);
  const active = branchEvidence(branch, sessionId, scrubber, visual?.archive.sources);
  const scopes: Array<{ evidence: BranchEvidence; parent?: LineageSession }> = [{ evidence: active }];
  const list = [...active.list];
  for (const parent of lineage) {
    const evidence = branchEvidence(parent.branch, parent.sessionId, scrubber);
    for (const source of evidence.list) {
      if (scopes.some(scope => scope.evidence.owns(source.id))) continue; // nearer scope wins an id collision
      list.push({ ...source, session: parent.sessionId, depth: parent.depth });
    }
    scopes.push({ evidence, parent });
  }
  const scopeOf = (id: string) => scopes.find(scope => scope.evidence.owns(id)) ?? scopes[0];
  /** The parent session an id resolves in; undefined for the active branch. */
  const origin = (id: string) => scopeOf(id).parent;
  const read = (id: string) => scopeOf(id).evidence.read(id);
  const search = async (query: string, offset: number, limit: number, id?: string) => {
    if (!query.trim() || query.length > 200) throw new Error("search requires 1–200 characters of literal text.");
    const sources = id ? list.filter(source => source.id === id) : list;
    if (id && !sources.length) throw new Error(lineage.length ? "No matching archived source on the active branch or its lineage." : "No matching archived source on the active branch.");
    const matches: Array<{ id: string; source: string; session?: string; matched: "text" | "source"; line: number; offset: number; excerpt: string }> = [];
    const unavailable: string[] = [];
    let cursor = Math.min(offset, sources.length);
    let scanned = 0;
    let chars = 0;
    while (cursor < sources.length && scanned < MAX_SEARCH_SOURCES && matches.length < limit) {
      const source = sources[cursor];
      if (chars + source.chars > MAX_SEARCH_CHARS) {
        if (scanned === 0) { unavailable.push(source.id); cursor++; }
        break;
      }
      cursor++;
      scanned++;
      chars += source.chars;
      let text: string;
      try { text = await read(source.id); }
      catch { unavailable.push(source.id); continue; }
      const at = text.indexOf(query);
      if (at < 0 && !source.source.includes(query)) continue;
      const start = Math.max(0, at - 80);
      matches.push({ id: source.id, source: source.source, ...(source.session ? { session: source.session } : {}), matched: at < 0 ? "source" : "text",
        line: text.slice(0, Math.max(0, at)).split("\n").length,
        offset: start, excerpt: text.slice(start, Math.min(text.length, start + 320)) });
    }
    return { matches, scanned, unavailable, nextOffset: cursor < sources.length ? cursor : null };
  };
  return { state: active.state, list, read, search, origin, visualExcerpts: visual?.archive.sources.length };
}

/** Line reads are still character-capped; nextOffset can finish a single oversized line. */
export function evidencePage(text: string, offset: number, limit: number, line?: number) {
  let start = offset;
  let end: number;
  if (line !== undefined) {
    if (!Number.isSafeInteger(line) || line < 1 || offset !== 0 || limit > 200) throw new Error("Line reads require line >= 1, offset 0, and limit <= 200 lines.");
    start = 0;
    for (let current = 1; current < line && start < text.length; current++) {
      const next = text.indexOf("\n", start);
      start = next < 0 ? text.length : next + 1;
    }
    end = start;
    for (let count = 0; count < limit && end < text.length && end - start < MAX_READ_CHARS; count++) {
      const next = text.indexOf("\n", end);
      end = next < 0 ? text.length : next + 1;
    }
    end = Math.min(end, start + MAX_READ_CHARS);
  } else end = Math.min(text.length, offset + Math.min(limit, MAX_READ_CHARS));
  return { text: text.slice(start, end), nextOffset: end < text.length ? end : null };
}
