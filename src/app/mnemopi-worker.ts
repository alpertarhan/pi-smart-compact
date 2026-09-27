import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Check } from "typebox/value";
import { MNEMOPI_READY, MnemopiMetadataSchema, MnemopiRequestSchema, type MnemopiRequest, type MnemopiOutcome } from "./mnemopi-protocol.ts";

async function execute(request: MnemopiRequest): Promise<MnemopiOutcome> {
  const { dbPath, projectId } = request;
  if (request.operation !== "save" && !existsSync(dbPath)) {
    if (request.operation === "recall") return { state: "recalled", dbPath, facts: [] };
    if (request.operation === "inspect") return { state: "inspected", dbPath, fact: null };
    return { state: "resolved", dbPath, closed: false };
  }
  // Private, extension-owned databases only; never the engine's shared default bank.
  process.umask(0o077);
  if (request.operation === "save") mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const byRef = request.operation !== "recall";
  const memory = new Mnemopi({
    dbPath,
    // One stable session per fact lets the public facade resolve without a sidecar index.
    sessionId: byRef ? request.memoryId : projectId,
    authorId: projectId,
    // remember() stores the channel; recall filters by it, so saves keep the
    // kind channel. getContext/forget key on the session (memoryId) only.
    channelId: request.operation === "save" ? request.kind : request.operation === "recall" ? projectId : "resolve",
    noEmbeddings: true,
    embeddings: false,
    llmEnabled: false,
    llm: false,
    proactiveLinking: false,
    reconcile: false,
  });
  try {
    if (request.operation === "recall") {
      const groups = request.kinds?.length ? [...new Set(request.kinds)] : [undefined];
      const facts: Extract<MnemopiOutcome, { state: "recalled" }>["facts"] = [];
      for (const kind of groups) {
        const matches = await memory.recall(request.query, request.limit, {
          authorId: projectId,
          channelId: kind,
          queryEmbedding: null,
          contentPreviewChars: 2_000,
        });
        for (const match of matches) {
          let metadata: unknown;
          try { metadata = JSON.parse(match.metadata_json ?? ""); } catch { continue; }
          if (!Check(MnemopiMetadataSchema, metadata) || metadata.projectId !== projectId ||
            match.source !== "pi-smart-compact:" + metadata.memoryId ||
            (kind !== undefined && metadata.kind !== kind)) continue;
          facts.push({
            id: match.id, memoryId: metadata.memoryId, kind: metadata.kind,
            title: metadata.title,
            content: match.content.slice(0, 2_000), score: match.score ?? 0,
          });
        }
      }
      facts.sort((a, b) => b.score - a.score);
      return { state: "recalled", dbPath, facts: facts.slice(0, request.limit) };
    }
    const source = "pi-smart-compact:" + request.memoryId;
    // The parent holds the project lock. The engine starts its own transactions.
    const rows = memory.getContext(2);
    const row = rows[0];
    if (rows.length > 1 || (row !== undefined &&
      (!row || typeof row !== "object" || !("source" in row) || row.source !== source ||
        !("id" in row) || typeof row.id !== "string"))) {
      throw new Error("Mnemopi fact scope contains unexpected entries; nothing changed");
    }
    const existingId = row && typeof row === "object" && "id" in row && typeof row.id === "string" ? row.id : null;
    if (request.operation === "inspect") {
      if (!existingId) return { state: "inspected", dbPath, fact: null };
      const raw = memory.get(existingId);
      const metadata = raw && typeof raw === "object" && "metadata" in raw
        ? Check(MnemopiMetadataSchema, (raw as { metadata: unknown }).metadata)
          ? (raw as { metadata: { kind: string; title: string } }).metadata
          : null
        : null;
      const content = raw && typeof raw === "object" && "content" in raw && typeof (raw as { content: unknown }).content === "string"
        ? (raw as { content: string }).content
        : "";
      return {
        state: "inspected", dbPath,
        fact: {
          memoryId: request.memoryId,
          kind: metadata?.kind ?? "fact",
          title: metadata?.title ?? "Saved fact",
          content: content.slice(0, 2_000),
        },
      };
    }
    if (request.operation === "resolve") {
      return { state: "resolved", dbPath, closed: existingId !== null && memory.forget(existingId) };
    }
    if (existingId) return { state: "saved", dbPath, id: existingId, memoryId: request.memoryId, existing: true };
    const id = memory.remember(request.content, {
      source, scope: "session", veracity: "stated", extract: false, extractEntities: false,
      metadata: { projectId, memoryId: request.memoryId, kind: request.kind, title: request.title, relatedPaths: request.relatedPaths },
    });
    return { state: "saved", dbPath, id, memoryId: request.memoryId, existing: false };
  } finally {
    memory.close();
  }
}

// No payload is sent until every optional/runtime dependency has loaded.
console.log(MNEMOPI_READY);
try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  if (!Check(MnemopiRequestSchema, input)) throw new Error("Invalid Mnemopi worker request");
  let outcome: MnemopiOutcome;
  try {
    outcome = await execute(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const dbPath = typeof (input as { dbPath?: unknown }).dbPath === "string"
      ? (input as { dbPath: string }).dbPath
      : undefined;
    outcome = input.operation === "recall"
      ? { state: "failed", reason, dbPath }
      : { state: "unknown", reason, dbPath };
  }
  console.log(JSON.stringify(outcome));
} catch (error) {
  console.log(JSON.stringify({ state: "failed", reason: error instanceof Error ? error.message : String(error) }));
}
