import type { SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

export interface ConflictingExtension {
  name: string;
  kind: "compaction" | "context-editing";
  evidence: string;
}

export interface ExtensionRegistry {
  commands: SlashCommandInfo[];
  tools: ToolInfo[];
}

type Entry = { name: string; label: string; segments: Set<string> };

const KIND: Record<string, ConflictingExtension["kind"]> = {
  "context-fold": "compaction",
  "pi-context-prune": "context-editing",
  "pi-dcp": "context-editing",
  "pi-fold": "context-editing",
  "pi-openai-toolkit": "compaction",
  "pi-toolkit": "context-editing",
};

const SEGMENT_OWNER: Record<string, string> = {
  "context-fold": "context-fold",
  dcp: "pi-dcp",
  "pi-context-prune": "pi-context-prune",
  "pi-dcp": "pi-dcp",
  "pi-fold": "pi-fold",
  "pi-openai-toolkit": "pi-openai-toolkit",
};

/** Whole path/source segments, lowercased, without `@version` and `.ts`/`.js`/`.git` suffixes. */
function segments(info: { path?: string; source?: string; baseDir?: string } | undefined): Set<string> {
  const out = new Set<string>();
  if (!info) return out;
  for (const text of [info.path ?? "", info.source ?? "", info.baseDir ?? ""]) {
    for (const raw of text.toLowerCase().split(/[\\/:]+/)) {
      const segment = raw.replace(/(.)@.*$/, "$1").replace(/\.(?:[cm]?[jt]s|git)$/, "");
      if (segment) out.add(segment);
    }
  }
  return out;
}

/** Known compaction or context-editing extensions visible in the live command/tool registry. Name-based evidence, not proof. */
export function detectExtensionConflicts(registry: ExtensionRegistry): ConflictingExtension[] {
  const entries: Entry[] = [
    ...registry.commands
      .filter((command) => command.source === "extension")
      .map((command) => ({ name: command.name.toLowerCase(), label: `/${command.name} command`, segments: segments(command.sourceInfo) })),
    ...registry.tools.map((tool) => ({ name: tool.name.toLowerCase(), label: `${tool.name} tool`, segments: segments(tool.sourceInfo) })),
  ].filter((entry) => !(entry.segments.has("pi-smart-compact") || entry.name.startsWith("smart_") || entry.name === "smart-compact"));

  const found = new Map<string, string>();
  const add = (name: string, evidence: string) => {
    if (!found.has(name)) found.set(name, evidence);
  };
  const bareFold: Entry[] = [];
  for (const entry of entries) {
    const owner = [...entry.segments].map((segment) => SEGMENT_OWNER[segment]).find(Boolean);
    if (owner) add(owner, `${entry.label} from ${owner}`);
    else if (entry.segments.has("pi-toolkit") && entry.name === "context") add("pi-toolkit", `${entry.label} from pi-toolkit`);
    else if (entry.name === "fold-handoff") add("context-fold", entry.label);
    else if (entry.name === "prune") add("pi-context-prune", entry.label);
    else if (entry.name === "fold") bareFold.push(entry);
  }
  for (const entry of bareFold) add(found.has("context-fold") ? "context-fold" : "pi-fold", entry.label);

  return [...found]
    .map(([name, evidence]) => ({ name, kind: KIND[name]!, evidence }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One notice naming every conflicting extension. */
export function conflictNotice(conflicts: ConflictingExtension[]): string {
  const names = conflicts.map((conflict) => conflict.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const verb = names.length === 1 ? "also compacts or edits" : "also compact or edit";
  const evidence = conflicts.map((conflict) => `${conflict.name}: ${conflict.evidence}`).join("; ");
  return `${list} ${verb} this conversation (${evidence}). Two owners of the same history are not safe in any load order: summaries can be discarded and cache prefixes rewritten twice. Keep only one loaded (Pi: /settings › packages, or the extensions list).`;
}
