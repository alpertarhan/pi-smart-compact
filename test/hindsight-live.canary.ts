/**
 * Opt-in live canary against a real Hindsight server. NOT run by `bun test`.
 *
 *   PSC_HINDSIGHT_LIVE=1 \
 *   PSC_HINDSIGHT_URL=https://hindsight.example.com \
 *   PSC_HINDSIGHT_BANK=my-bank \
 *   PSC_HINDSIGHT_KEY_ENV=HINDSIGHT_API_TOKEN \
 *   bun run test/hindsight-live.canary.ts
 *
 * Hard request budget, enforced by a fetch guard: 1 retain, <= 10 operation
 * status GETs, 1 recall, 1 document DELETE; nothing else. The retain is a
 * synthetic fact under a unique per-run project tag; cleanup deletes only that
 * owned document. There are no retries. HOME points at a temporary directory
 * so no user files (settings, receipts, graph) are read or written. Only ids,
 * states and counts are printed: never the token or other records' content.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (process.env.PSC_HINDSIGHT_LIVE !== "1") {
  console.log("skipped: set PSC_HINDSIGHT_LIVE=1 to run the live Hindsight canary");
  process.exit(0);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "psc-hindsight-canary-"));
process.env.HOME = tempHome;

const { resolveHindsightTarget, saveHindsightMemory, recallHindsightMemory, resolveHindsightMemory, hindsightDocumentId, projectTag } =
  await import("../src/app/hindsight-memory.ts");
const { getOperationStatus } = await import("../src/infra/hindsight-client.ts");
const { updateReceiptState, listReceipts } = await import("../src/infra/hindsight-receipts.ts");

const BUDGET = { retain: 1, status: 10, recall: 1, delete: 1 } as const;
type Route = keyof typeof BUDGET;
const used: Record<Route, number> = { retain: 0, status: 0, recall: 0, delete: 0 };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const p = url.pathname;
  const route: Route | null =
    method === "POST" && /\/memories$/.test(p)
      ? "retain"
      : method === "GET" && /\/operations\/[^/]+$/.test(p)
        ? "status"
        : method === "POST" && /\/memories\/recall$/.test(p)
          ? "recall"
          : method === "DELETE" && /\/documents\/[^/]+$/.test(p)
            ? "delete"
            : null;
  if (!route) throw new Error("canary guard: unexpected route " + method + " " + p);
  if (used[route] >= BUDGET[route]) throw new Error("canary guard: budget exhausted for " + route);
  used[route] += 1;
  return realFetch(input, init);
}) as typeof fetch;

const keyEnv = process.env.PSC_HINDSIGHT_KEY_ENV ?? "HINDSIGHT_API_TOKEN";
const resolved = resolveHindsightTarget(
  {
    memoryBackend: "hindsight",
    hindsightBaseUrl: process.env.PSC_HINDSIGHT_URL ?? null,
    hindsightBankId: process.env.PSC_HINDSIGHT_BANK ?? null,
    hindsightApiKeyEnv: keyEnv,
    hindsightTimeoutMs: 20_000,
  },
  process.env,
);
if (!resolved.enabled || !resolved.ok) {
  console.error("canary config invalid:", resolved.enabled ? resolved.reason : "disabled");
  process.exit(2);
}
const target = resolved.target;
const runId = randomUUID();
const projectId = "psc-canary-" + runId;
const memoryId = "canary-" + runId;
const documentId = hindsightDocumentId(memoryId);
const report: Record<string, unknown> = {
  target: target.baseUrl + " bank " + target.bankId,
  projectTag: projectTag(projectId),
  documentId,
};
const log = (step: string, value: unknown) => console.log(step + ": " + JSON.stringify(value));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let exitCode = 0;
try {
  const save = await saveHindsightMemory(target, {
    projectId,
    memoryId,
    kind: "decision",
    title: "Smart Compact Hindsight canary " + runId.slice(0, 8),
    content:
      "Synthetic canary decision for pi-smart-compact run " +
      runId +
      ": confirmed saves use a stable document id and strict project tags. Safe to delete.",
    relatedPaths: [],
  });
  const receipt = "receipt" in save ? save.receipt : undefined;
  report.operationId = receipt?.operationId;
  log("retain", { state: save.state, operationId: receipt?.operationId, reason: "reason" in save ? save.reason : undefined });

  let state: string = save.state;
  if (receipt && (state === "accepted" || state === "unknown")) {
    const waits = [2_000, 3_000, 5_000, 5_000, 8_000, 10_000, 12_000, 15_000, 20_000];
    for (const wait of waits) {
      if (used.status >= BUDGET.status) break;
      await sleep(wait);
      const status = await getOperationStatus(target, receipt.operationId);
      log("status", { poll: used.status, status: status.status });
      if (status.status === "completed") {
        updateReceiptState(receipt.key, "completed");
        state = "completed";
        break;
      }
      if (status.failed) {
        updateReceiptState(receipt.key, "failed", "operation " + status.status);
        state = "failed";
        break;
      }
      if (status.status === "pending" || status.status === "processing") {
        updateReceiptState(receipt.key, "accepted");
        state = "accepted";
      }
    }
  }
  report.retainFinalState = state;

  if (state === "completed") {
    const recall = await recallHindsightMemory(target, projectId, "canary strict project tags stable document id", 512);
    if (recall.state === "ok") {
      const ownOnly = recall.facts.every((fact) => fact.tags.includes(projectTag(projectId)));
      const fromOwnDoc = recall.facts.filter((fact) => fact.documentId === documentId).length;
      report.recall = { facts: recall.facts.length, fromOwnDoc, allInScope: ownOnly };
    } else {
      report.recall = { state: "failed", reason: recall.reason };
      exitCode = 1;
    }
  } else {
    report.recall = { state: "skipped", reason: "retain not completed" };
    exitCode = 1;
  }
  log("recall", report.recall);
} catch (error) {
  report.error = error instanceof Error ? error.message : "unknown error";
  exitCode = 1;
} finally {
  try {
    const cleanup = await resolveHindsightMemory(target, projectId, memoryId);
    report.cleanup = cleanup;
    if (cleanup.state !== "deleted") exitCode = 1;
  } catch (error) {
    report.cleanup = { state: "failed", reason: error instanceof Error ? error.message : "unknown" };
    exitCode = 1;
  }
  report.receipts = listReceipts({ baseUrl: target.baseUrl, bankId: target.bankId, projectId }).map(
    (receipt) => ({ operationId: receipt.operationId, state: receipt.state }),
  );
  report.requestsUsed = used;
  report.budget = BUDGET;
  log("report", report);
  fs.rmSync(tempHome, { recursive: true, force: true });
  process.exit(exitCode);
}
