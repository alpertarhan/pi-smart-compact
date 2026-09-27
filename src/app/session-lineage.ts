/** Read-only walk up `parentSession` headers (handoff/fork); never opens or writes a session through Pi. */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSessionEntries, SessionManager, type ExtensionContext, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { LINEAGE_MAX_DEPTH, LINEAGE_MAX_FILE_BYTES } from "../constants.ts";

export interface LineageSession { sessionId: string; file: string; branch: SessionEntry[]; depth: number }

/**
 * Parent sessions nearest-first. The walk stops at a missing, unreadable, oversized,
 * header-less or already-seen file, and after `maxDepth` levels.
 */
export async function loadLineage(ctx: Pick<ExtensionContext, "sessionManager">, options: {
  maxDepth?: number; maxBytes?: number; signal?: AbortSignal;
} = {}): Promise<LineageSession[]> {
  const maxDepth = options.maxDepth ?? LINEAGE_MAX_DEPTH;
  const maxBytes = options.maxBytes ?? LINEAGE_MAX_FILE_BYTES;
  const own = ctx.sessionManager.getSessionFile();
  const seen = new Set<string>([ctx.sessionManager.getSessionId()]);
  if (own) seen.add(path.resolve(own));
  const lineage: LineageSession[] = [];
  let parent = ctx.sessionManager.getHeader()?.parentSession;
  for (let depth = 1; depth <= maxDepth && parent && path.isAbsolute(parent); depth++) {
    if (options.signal?.aborted) throw new Error("Context operation cancelled.");
    const file = path.resolve(parent);
    if (seen.has(file)) break;
    seen.add(file);
    let entries: FileEntry[];
    try {
      if ((await fs.promises.stat(file)).size > maxBytes) break;
      entries = parseSessionEntries(await fs.promises.readFile(file, { encoding: "utf8", signal: options.signal }));
    } catch {
      if (options.signal?.aborted) throw new Error("Context operation cancelled.");
      break;
    }
    const header = entries[0];
    if (header?.type !== "session" || typeof header.id !== "string" || !header.id || seen.has(header.id)) break;
    seen.add(header.id);
    const cwd = typeof header.cwd === "string" && header.cwd ? header.cwd : process.cwd();
    // No session file: the in-memory manager cannot write back.
    const session = SessionManager.inMemory(cwd, undefined, entries);
    lineage.push({ sessionId: session.getSessionId(), file, branch: session.getBranch(), depth });
    parent = typeof header.parentSession === "string" ? header.parentSession : undefined;
  }
  return lineage;
}
