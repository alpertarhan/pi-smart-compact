/**
 * Extractor generation stamping: a disposable extraction cache written by an
 * older build must never stand in for current-algorithm facts, even when every
 * fingerprint matches (the #144 sed-script fix resurrected `s/a/b/` from an
 * old cache). Old/missing/malformed stamps are misses before exact/incremental
 * acceptance; current-generation caches keep working; legacy JSON still loads.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { selectCachedExtraction } from "../src/app/steps/extract.ts";
import { saveCachedExtraction, loadCachedExtraction } from "../src/utils/cache.ts";
import { extractStructured } from "../src/utils/extraction.ts";
import { buildEntryIdFingerprint, hashMessages } from "../src/utils/id-fingerprint.ts";
import { extractionCacheFile } from "../src/infra/paths.ts";
import { PROFILES, VERSION } from "../src/constants.ts";
import type { CachedExtraction, LlmMessage, StructuredExtraction } from "../src/types.ts";

// Parent's repro command: the pre-#144 rule recorded the sed script operand
// `s/a/b/` as an edited file; current code records nothing for a non-literal
// target. No shell command is executed here.
const SED_COMMAND = "F=src/a.ts; sed -i 's/a/b/' $F";
const FAKE_PATH = "s/a/b/";

function sedWindow(extra: LlmMessage[] = []): LlmMessage[] {
  return [
    { role: "user", content: "Replace the a placeholders with b in the source." },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: SED_COMMAND } }] },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "" }] },
    ...extra,
  ] as unknown as LlmMessage[];
}

function makeExtraction(partial: Partial<StructuredExtraction> = {}): StructuredExtraction {
  return {
    modifiedFiles: [], readFiles: [], deletedFiles: [], mediaAttachments: [],
    errors: [], decisions: [], constraints: [], topics: [], timeline: [],
    mainGoal: null, lastUserMessages: [], lastErrors: [], messageCount: 0,
    ...partial,
  };
}

/** What the pre-fix extractor produced for the sed window (fake path included). */
function staleSedExtraction(messageCount: number): StructuredExtraction {
  return makeExtraction({
    modifiedFiles: [{ path: FAKE_PATH, toolCalls: 1, lastModifiedIndex: 1 }],
    messageCount,
  });
}

/** A cache whose fingerprints genuinely match the current window. */
function matchingCache(
  msgs: LlmMessage[], prefixCount: number, extraction: StructuredExtraction,
  generation?: string,
): CachedExtraction {
  const ids = msgs.map((_, index) => "m-" + index);
  return {
    lastMessageIndex: prefixCount - 1,
    extraction,
    messageCount: prefixCount,
    timestamp: Date.now(),
    ...(generation !== undefined ? { generation } : {}),
    entryIdsFp: buildEntryIdFingerprint(ids.slice(0, prefixCount)),
    keptEntryIdsFp: buildEntryIdFingerprint(ids.slice(0, prefixCount)),
    messagePrefixHash: hashMessages(msgs, prefixCount),
  };
}

function select(
  msgs: LlmMessage[], cachedExt: CachedExtraction | null,
) {
  const ids = msgs.map((_, index) => "m-" + index);
  return selectCachedExtraction({
    llmMessages: msgs, profileCfg: PROFILES.balanced,
    currentEntryIds: ids, currentKeptEntryIds: ids, cachedExt,
  });
}

describe("extractor generation stamp", () => {
  it("rejects an exact cache without a generation stamp despite matching fingerprints", () => {
    const msgs = sedWindow([{ role: "user", content: "thanks, continue" }]);
    const selection = select(msgs, matchingCache(msgs, msgs.length, staleSedExtraction(msgs.length)));
    expect(selection.cache).toBe("miss");
    expect(selection.missReason).toBe("stale-extractor-generation");
    expect(selection.extraction.modifiedFiles.map((file) => file.path)).not.toContain(FAKE_PATH);
  });

  it("rejects an incremental cache with an old or malformed generation stamp", () => {
    const msgs = sedWindow([{ role: "user", content: "thanks, continue" }]);
    const prefix = msgs.length - 1;
    for (const generation of ["10.7.3", "", 10, null, {}] as unknown as Array<string | undefined>) {
      const selection = select(msgs, matchingCache(msgs, prefix, staleSedExtraction(prefix), generation as string));
      expect(selection.cache).toBe("miss");
      expect(selection.missReason).toBe("stale-extractor-generation");
      expect(selection.extraction.modifiedFiles.map((file) => file.path)).not.toContain(FAKE_PATH);
    }
  });

  it("still reuses exact and incremental caches stamped with the current generation", () => {
    const msgs = sedWindow([{ role: "user", content: "thanks, continue" }]);
    const exact = select(msgs, matchingCache(msgs, msgs.length, extractStructured(msgs, PROFILES.balanced), VERSION));
    expect(exact.cache).toBe("exact");

    const prefix = msgs.length - 1;
    const incremental = select(msgs, matchingCache(msgs, prefix, extractStructured(msgs.slice(0, prefix), PROFILES.balanced), VERSION));
    expect(incremental.cache).toBe("incremental");
  });

  it("stamps the current generation on save and round-trips it through load", () => {
    const sessionId = "test-cache-generation-" + Date.now();
    try {
      saveCachedExtraction(sessionId, makeExtraction({ messageCount: 1 }), 1, "e-0", "e-0");
      const loaded = loadCachedExtraction(sessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.generation).toBe(VERSION);
      // A saved current-generation cache is selectable again.
      const msgs = sedWindow();
      const ids = msgs.map((_, index) => "m-" + index);
      const selection = selectCachedExtraction({
        llmMessages: msgs, profileCfg: PROFILES.balanced, currentEntryIds: ids, currentKeptEntryIds: ids,
        cachedExt: { ...loaded!, messageCount: msgs.length, lastMessageIndex: msgs.length - 1, extraction: extractStructured(msgs, PROFILES.balanced), entryIdsFp: buildEntryIdFingerprint(ids), keptEntryIdsFp: buildEntryIdFingerprint(ids), messagePrefixHash: hashMessages(msgs) },
      });
      expect(selection.cache).toBe("exact");
    } finally {
      try { fs.unlinkSync(extractionCacheFile(sessionId)); } catch { /* already gone */ }
    }
  });

  it("loads legacy cache JSON without a stamp — it just cannot be selected", () => {
    const sessionId = "test-cache-legacy-json-" + Date.now();
    const file = extractionCacheFile(sessionId);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Exactly the shape 10.8.0 wrote: no generation field.
      fs.writeFileSync(file, JSON.stringify({
        lastMessageIndex: 0, extraction: makeExtraction({ messageCount: 1 }),
        messageCount: 1, timestamp: Date.now(),
      }));
      const loaded = loadCachedExtraction(sessionId, { readOnly: true });
      expect(loaded).not.toBeNull();
      expect(loaded!.generation).toBeUndefined();
      const msgs = sedWindow();
      const ids = msgs.map((_, index) => "m-" + index);
      const selection = selectCachedExtraction({
        llmMessages: msgs, profileCfg: PROFILES.balanced, currentEntryIds: ids, currentKeptEntryIds: ids,
        cachedExt: { ...loaded!, entryIdsFp: buildEntryIdFingerprint(ids), keptEntryIdsFp: buildEntryIdFingerprint(ids), messagePrefixHash: hashMessages(msgs) },
      });
      expect(selection.cache).toBe("miss");
      expect(selection.missReason).toBe("stale-extractor-generation");
      // A read-only preview never deletes, migrates or rewrites the file.
      expect(fs.existsSync(file)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).generation).toBeUndefined();
    } finally {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  });
});
