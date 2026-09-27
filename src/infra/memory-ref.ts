import { createHash } from "node:crypto";

/**
 * Stable memory references shown by save/recall results and required by
 * smart_save_memory status=resolved.
 *
 * A ref names the backend that holds the fact, the id that backend assigned,
 * and a digest of the exact target (graph file / data root / server+bank).
 * Hindsight also binds the project and document id. Saving the same fact to
 * two targets therefore produces two distinct refs, and after a configuration
 * switch an old ref refuses to act instead of silently retargeting.
 *
 * Refs never carry a raw URL, bank id, or filesystem path, so a caller cannot
 * redirect an action to another target: the destination is always re-derived
 * from current configuration and compared against the digest.
 */

export type MemoryRefBackend = "local" | "mnemopi" | "hindsight";

export interface MemoryRef {
 backend: MemoryRefBackend;
 id: string;
 /** Mandatory 96-bit digest of the exact backend storage target. */
 target: string;
}

/** Local graph node ids and manual memory ids are both `cg-` + 24 hex chars. */
const REF_ID = "cg-[0-9a-f]{24}";
const MEMORY_REF_PATTERN = new RegExp(
 "^(local|mnemopi|hindsight):(" + REF_ID + ")@([0-9a-f]{24})$",
);

export function localTargetDigest(graphFile: string): string {
 return createHash("sha256")
  .update("local\u0000" + graphFile)
  .digest("hex")
  .slice(0, 24);
}

export function hindsightTargetDigest(
 baseUrl: string, bankId: string, projectId: string, memoryId: string,
): string {
 return createHash("sha256")
  .update("hindsight\u0000" + baseUrl + "\u0000" + bankId + "\u0000" + projectId + "\u0000" + memoryId)
  .digest("hex")
  .slice(0, 24);
}

export function mnemopiTargetDigest(dbPath: string): string {
 return createHash("sha256")
  .update("mnemopi\u0000" + dbPath)
  .digest("hex")
  .slice(0, 24);
}

/** Parse and validate one ref; anything else (URLs, paths, free text) is null. */
export function parseMemoryRef(value: string): MemoryRef | null {
 const match = MEMORY_REF_PATTERN.exec(value.trim());
 return match
  ? { backend: match[1] as MemoryRefBackend, id: match[2], target: match[3] }
  : null;
}
