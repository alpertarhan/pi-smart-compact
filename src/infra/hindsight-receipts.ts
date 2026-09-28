/**
 * Local ledger of Hindsight submissions made by confirmed smart_save_memory
 * calls. The ledger is the only honest source for "what did we send where":
 * every receipt is keyed by origin + bank + project + document + revision so a
 * target change can never resolve or report another server's state.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errorDetail, reportIssue } from "../utils/issues.ts";
import { isRecord } from "../utils/type-guards.ts";
import { acquireLockSync, ensureDir, writeJsonSync } from "./fs.ts";
import { contextGraphFile } from "./paths.ts";

export type HindsightReceiptState =
  /** Request sent, no response yet (process died mid-flight). */
  | "submitted"
  /** Server acknowledged the async operation; extraction not yet complete. */
  | "accepted"
  /** Operation completed; facts are searchable. */
  | "completed"
  /** Server reported failure/cancellation, or refused the request. */
  | "failed"
  /** Transport failure: the server may or may not have accepted it. */
  | "unknown"
  /** The owned document was deleted by a confirmed resolve. */
  | "deleted";

export interface HindsightReceipt {
  key: string;
  baseUrl: string;
  bankId: string;
  projectId: string;
  documentId: string;
  revision: string;
  operationId: string;
  kind: string;
  title: string;
  state: HindsightReceiptState;
  createdAt: number;
  updatedAt: number;
  /** Short, secret-free failure reason. */
  detail?: string;
}

export interface HindsightReceiptScope {
  baseUrl: string;
  bankId: string;
  projectId: string;
}

interface ReceiptFile {
  version: 1;
  receipts: HindsightReceipt[];
}

export const MAX_HINDSIGHT_RECEIPTS = 500;

const OPEN_STATES: readonly HindsightReceiptState[] = [
  "submitted",
  "accepted",
  "unknown",
];

export function isOpenReceipt(receipt: HindsightReceipt): boolean {
  return OPEN_STATES.includes(receipt.state);
}

export function hindsightReceiptsFile(): string {
  return path.join(path.dirname(contextGraphFile()), "hindsight-receipts.json");
}

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export function receiptKey(
  scope: HindsightReceiptScope,
  documentId: string,
  revision: string,
): string {
  return hash([scope.baseUrl, scope.bankId, scope.projectId, documentId, revision]).slice(0, 32);
}

/**
 * Deterministic UUID-shaped operation id for one submission, so a retry of the
 * same confirmed save is idempotent server-side and never double-retains.
 */
export function operationIdFor(
  scope: HindsightReceiptScope,
  documentId: string,
  revision: string,
): string {
  const hex = hash(["op", scope.baseUrl, scope.bankId, scope.projectId, documentId, revision]);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-5" +
    hex.slice(13, 16) +
    "-" +
    variant +
    hex.slice(17, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

/**
 * A present but unreadable ledger is never treated as empty: that would let a
 * resolve delete a document with in-flight retains, and the next save would
 * overwrite the evidence. Callers refuse instead; the file is left untouched.
 */
export class ReceiptLedgerUnreadableError extends Error {
  constructor(file: string, detail: string) {
    super(
      "Hindsight receipt ledger " +
        file +
        " is unreadable (" +
        detail +
        "); it was left untouched. Repair or move it aside before saving or resolving Hindsight memories",
    );
    this.name = "ReceiptLedgerUnreadableError";
  }
}

function unreadableLedger(file: string, detail: string, error?: unknown): ReceiptLedgerUnreadableError {
  const failure = new ReceiptLedgerUnreadableError(file, detail);
  reportIssue({ key: "hindsight-receipts-unreadable:" + file, message: failure.message, error });
  return failure;
}

function readAll(file: string): HindsightReceipt[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw unreadableLedger(file, errorDetail(error), error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw unreadableLedger(file, errorDetail(error), error);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.receipts)) {
    throw unreadableLedger(file, "unexpected ledger shape");
  }
  return (parsed as unknown as ReceiptFile).receipts.filter(
    (item) =>
      item &&
      typeof item.key === "string" &&
      typeof item.documentId === "string" &&
      typeof item.operationId === "string",
  );
}

function sameScope(receipt: HindsightReceipt, scope: HindsightReceiptScope): boolean {
  return (
    receipt.baseUrl === scope.baseUrl &&
    receipt.bankId === scope.bankId &&
    receipt.projectId === scope.projectId
  );
}

export function listReceipts(
  scope: HindsightReceiptScope,
  documentId?: string,
  file = hindsightReceiptsFile(),
): HindsightReceipt[] {
  return readAll(file).filter(
    (receipt) =>
      sameScope(receipt, scope) &&
      (documentId === undefined || receipt.documentId === documentId),
  );
}

export class ReceiptLedgerFullError extends Error {
  constructor() {
    super(
      "Hindsight receipt ledger is full of unconfirmed submissions (" +
        MAX_HINDSIGHT_RECEIPTS +
        "); run smart_recall to refresh pending receipts before saving more",
    );
    this.name = "ReceiptLedgerFullError";
  }
}

/**
 * Insert or update one receipt. Terminal receipts are pruned oldest-first when
 * the cap is reached; open receipts are never evicted — the write is refused.
 */
export function upsertReceipt(
  receipt: HindsightReceipt,
  file = hindsightReceiptsFile(),
): HindsightReceipt {
  ensureDir(path.dirname(file));
  const release = acquireLockSync(file);
  try {
    const receipts = readAll(file);
    const index = receipts.findIndex((item) => item.key === receipt.key);
    if (index >= 0) {
      receipts[index] = { ...receipt, createdAt: receipts[index].createdAt };
    } else {
      if (receipts.length >= MAX_HINDSIGHT_RECEIPTS) {
        const terminal = receipts
          .map((item, position) => ({ item, position }))
          .filter(({ item }) => !isOpenReceipt(item))
          .sort((a, b) => a.item.updatedAt - b.item.updatedAt);
        const excess = receipts.length - MAX_HINDSIGHT_RECEIPTS + 1;
        if (terminal.length < excess) throw new ReceiptLedgerFullError();
        const drop = new Set(terminal.slice(0, excess).map(({ position }) => position));
        const kept = receipts.filter((_, position) => !drop.has(position));
        receipts.length = 0;
        receipts.push(...kept);
      }
      receipts.push(receipt);
    }
    writeJsonSync(file, { version: 1, receipts } satisfies ReceiptFile, true);
    return receipt;
  } finally {
    release();
  }
}

export function updateReceiptState(
  key: string,
  state: HindsightReceiptState,
  detail?: string,
  file = hindsightReceiptsFile(),
): HindsightReceipt | null {
  const release = acquireLockSync(file);
  try {
    const receipts = readAll(file);
    const receipt = receipts.find((item) => item.key === key);
    if (!receipt) return null;
    receipt.state = state;
    receipt.updatedAt = Date.now();
    if (detail) receipt.detail = detail;
    else delete receipt.detail;
    writeJsonSync(file, { version: 1, receipts } satisfies ReceiptFile, true);
    return receipt;
  } finally {
    release();
  }
}

/** Capacity check before a remote submission, without writing. */
export function receiptCapacityAvailable(file = hindsightReceiptsFile()): boolean {
  const receipts = readAll(file);
  return (
    receipts.length < MAX_HINDSIGHT_RECEIPTS ||
    receipts.some((receipt) => !isOpenReceipt(receipt))
  );
}
