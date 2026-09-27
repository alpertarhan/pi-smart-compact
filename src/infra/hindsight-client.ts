/**
 * Minimal Hindsight HTTP client for Smart Compact's confirmed memory path.
 *
 * Deliberately exposes only four fixed bank-scoped routes (retain, operation
 * status, recall, delete one document). There is no generic request method, so
 * destructive bank-wide routes such as `DELETE /memories` are unreachable.
 */

export interface HindsightTarget {
  /** Normalized origin plus optional path prefix, without trailing slash. */
  baseUrl: string;
  bankId: string;
  /** Bearer token value; never persisted or rendered. */
  apiKey?: string;
  timeoutMs: number;
}

export type HindsightErrorKind =
  | "config"
  | "aborted"
  | "timeout"
  | "network"
  | "unauthorized"
  | "not-found"
  | "conflict"
  | "http"
  | "invalid-response";

export class HindsightError extends Error {
  readonly kind: HindsightErrorKind;
  readonly status?: number;
  constructor(kind: HindsightErrorKind, message: string, status?: number) {
    super(message);
    this.name = "HindsightError";
    this.kind = kind;
    this.status = status;
  }
  /** True when the server may or may not have received the request. */
  get outcomeUnknown(): boolean {
    return this.kind === "timeout" || this.kind === "network";
  }
}

export type HindsightOperationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "not_found";

const OPERATION_STATUSES: readonly HindsightOperationStatus[] = [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
  "not_found",
];

export interface HindsightRetainItem {
  content: string;
  documentId: string;
  context?: string;
  tags: string[];
  metadata: Record<string, string>;
}

export interface HindsightRecallFact {
  id: string;
  text: string;
  type: string | null;
  documentId: string | null;
  tags: string[];
  metadata: Record<string, string>;
  mentionedAt: string | null;
}

const BANK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_RESPONSE_CAP = 64 * 1024;
const RECALL_RESPONSE_CAP = 512 * 1024;
const MAX_RECALL_FACTS = 50;
const MAX_FACT_CHARS = 4_000;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Validate and normalize a configured base URL. HTTPS is required except for
 * loopback development servers; credentials, query and fragment are refused.
 */
export function normalizeHindsightBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HindsightError("config", "Hindsight base URL is not configured");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HindsightError("config", "Hindsight base URL is not a valid URL");
  }
  if (url.username || url.password) {
    throw new HindsightError(
      "config",
      "Hindsight base URL must not contain credentials",
    );
  }
  if (url.search || url.hash) {
    throw new HindsightError(
      "config",
      "Hindsight base URL must not contain a query or fragment",
    );
  }
  if (url.protocol !== "https:") {
    if (!(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      throw new HindsightError(
        "config",
        "Hindsight base URL must use https (plain http is allowed only for loopback)",
      );
    }
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

export function isValidHindsightBankId(value: unknown): value is string {
  return typeof value === "string" && BANK_ID_PATTERN.test(value);
}

/** Display-safe destination label (origin + bank), never includes secrets. */
export function describeHindsightTarget(target: HindsightTarget): string {
  return target.baseUrl + " (bank " + target.bankId + ")";
}

function bankPath(target: HindsightTarget, ...segments: string[]): string {
  if (!isValidHindsightBankId(target.bankId)) {
    throw new HindsightError("config", "Hindsight bank id is invalid");
  }
  return (
    target.baseUrl +
    "/v1/default/banks/" +
    encodeURIComponent(target.bankId) +
    segments.map((segment) => "/" + encodeURIComponent(segment)).join("")
  );
}

async function readCapped(response: Response, cap: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    throw new HindsightError(
      "invalid-response",
      "Hindsight response exceeded " + cap + " bytes",
      response.status,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new HindsightError(
        "invalid-response",
        "Hindsight response exceeded " + cap + " bytes",
        response.status,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorForStatus(status: number): HindsightError {
  if (status === 401 || status === 403) {
    return new HindsightError(
      "unauthorized",
      "Hindsight rejected the credentials (HTTP " + status + ")",
      status,
    );
  }
  if (status === 404) {
    return new HindsightError("not-found", "Hindsight returned HTTP 404", status);
  }
  if (status === 409) {
    return new HindsightError(
      "conflict",
      "Hindsight reported an operation id conflict (HTTP 409)",
      status,
    );
  }
  return new HindsightError("http", "Hindsight returned HTTP " + status, status);
}

async function requestJson(
  target: HindsightTarget,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  cap = DEFAULT_RESPONSE_CAP,
): Promise<unknown> {
  if (signal?.aborted) {
    throw new HindsightError("aborted", "Hindsight request cancelled");
  }
  const timeout = AbortSignal.timeout(target.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (target.apiKey) headers.authorization = "Bearer " + target.apiKey;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: combined,
    });
  } catch {
    // Never propagate runtime error text: it can echo URLs or headers.
    if (signal?.aborted) {
      throw new HindsightError("aborted", "Hindsight request cancelled");
    }
    if (timeout.aborted) {
      throw new HindsightError(
        "timeout",
        "Hindsight request timed out after " + target.timeoutMs + "ms",
      );
    }
    throw new HindsightError("network", "Hindsight server is unreachable");
  }
  let text: string;
  try {
    text = await readCapped(response, cap);
  } catch (error) {
    if (error instanceof HindsightError) throw error;
    if (signal?.aborted) {
      throw new HindsightError("aborted", "Hindsight request cancelled");
    }
    throw new HindsightError(
      timeout.aborted ? "timeout" : "network",
      "Hindsight response could not be read",
    );
  }
  if (!response.ok) throw errorForStatus(response.status);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HindsightError(
      "invalid-response",
      "Hindsight returned invalid JSON",
      response.status,
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * Submit one asynchronous retain. The caller-supplied operation id makes
 * retries of the same submission idempotent on the server. Acceptance is not
 * completion: extracted facts are not searchable until the operation completes.
 */
export async function retainDocument(
  target: HindsightTarget,
  item: HindsightRetainItem,
  operationId: string,
  signal?: AbortSignal,
): Promise<{ operationId: string }> {
  const payload = {
    items: [
      {
        content: item.content,
        document_id: item.documentId,
        context: item.context,
        tags: item.tags,
        metadata: item.metadata,
        update_mode: "replace",
      },
    ],
    async: true,
    operation_id: operationId,
  };
  const response = record(
    await requestJson(target, "POST", bankPath(target, "memories"), payload, signal),
  );
  if (response.success === false) {
    throw new HindsightError("invalid-response", "Hindsight refused the retain");
  }
  const returned =
    stringOrNull(response.operation_id) ??
    stringArray(response.operation_ids)[0] ??
    null;
  if (response.async !== true || !returned) {
    throw new HindsightError(
      "invalid-response",
      "Hindsight did not acknowledge an asynchronous operation",
    );
  }
  return { operationId: returned };
}

export async function getOperationStatus(
  target: HindsightTarget,
  operationId: string,
  signal?: AbortSignal,
): Promise<{ status: HindsightOperationStatus; failed: boolean }> {
  let response: Record<string, unknown>;
  try {
    response = record(
      await requestJson(
        target,
        "GET",
        bankPath(target, "operations", operationId),
        undefined,
        signal,
      ),
    );
  } catch (error) {
    if (error instanceof HindsightError && error.kind === "not-found") {
      return { status: "not_found", failed: false };
    }
    throw error;
  }
  const status = response.status;
  if (!OPERATION_STATUSES.includes(status as HindsightOperationStatus)) {
    throw new HindsightError(
      "invalid-response",
      "Hindsight returned an unknown operation status",
    );
  }
  return {
    status: status as HindsightOperationStatus,
    failed: status === "failed" || status === "cancelled",
  };
}

export interface HindsightRecallRequest {
  query: string;
  tags: string[];
  maxTokens: number;
}

/** Bounded, strictly tag-scoped recall. No reflect, chunks or source facts. */
export async function recallFacts(
  target: HindsightTarget,
  request: HindsightRecallRequest,
  signal?: AbortSignal,
): Promise<HindsightRecallFact[]> {
  if (request.tags.length === 0) {
    throw new HindsightError("config", "Hindsight recall requires scope tags");
  }
  const response = record(
    await requestJson(
      target,
      "POST",
      bankPath(target, "memories", "recall"),
      {
        query: request.query,
        budget: "low",
        max_tokens: request.maxTokens,
        tags: request.tags,
        tags_match: "all_strict",
        include: { entities: null },
      },
      signal,
      RECALL_RESPONSE_CAP,
    ),
  );
  if (!Array.isArray(response.results)) {
    throw new HindsightError(
      "invalid-response",
      "Hindsight recall response has no results array",
    );
  }
  const required = new Set(request.tags);
  const facts: HindsightRecallFact[] = [];
  for (const raw of response.results.slice(0, MAX_RECALL_FACTS)) {
    const item = record(raw);
    const id = stringOrNull(item.id);
    const text = stringOrNull(item.text);
    if (!id || !text) continue;
    const tags = stringArray(item.tags);
    // Defense in depth: never surface a fact outside the requested scope even
    // if a server ignores tags_match.
    if (![...required].every((tag) => tags.includes(tag))) continue;
    facts.push({
      id,
      text: text.slice(0, MAX_FACT_CHARS),
      type: stringOrNull(item.type),
      documentId: stringOrNull(item.document_id),
      tags,
      metadata: stringRecord(item.metadata),
      mentionedAt: stringOrNull(item.mentioned_at),
    });
  }
  return facts;
}

/** Delete exactly one owned document. A missing document is reported, not thrown. */
export async function deleteDocument(
  target: HindsightTarget,
  documentId: string,
  signal?: AbortSignal,
): Promise<{ found: boolean; memoryUnitsDeleted: number }> {
  try {
    const response = record(
      await requestJson(
        target,
        "DELETE",
        bankPath(target, "documents", documentId),
        undefined,
        signal,
      ),
    );
    const deleted = Number(response.memory_units_deleted);
    return {
      found: true,
      memoryUnitsDeleted: Number.isFinite(deleted) ? deleted : 0,
    };
  } catch (error) {
    if (error instanceof HindsightError && error.kind === "not-found") {
      return { found: false, memoryUnitsDeleted: 0 };
    }
    throw error;
  }
}
