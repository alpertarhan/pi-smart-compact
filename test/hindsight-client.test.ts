import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  deleteDocument,
  getOperationStatus,
  HindsightError,
  normalizeHindsightBaseUrl,
  recallFacts,
  retainDocument,
  type HindsightTarget,
} from "../src/infra/hindsight-client.ts";
import { startHindsightFake, type HindsightFake } from "./hindsight-fake.ts";

let fake: HindsightFake;
let target: HindsightTarget;

beforeEach(() => {
  fake = startHindsightFake();
  target = { baseUrl: fake.url, bankId: "bank-a", apiKey: "test-token", timeoutMs: 2_000 };
});

afterEach(() => fake.stop());

const item = {
  content: "Decision: use strict tags",
  documentId: "psc-cg-1",
  tags: ["psc-project:p1"],
  metadata: { kind: "decision" },
};

async function rejects(promise: Promise<unknown>): Promise<HindsightError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HindsightError);
    return error as HindsightError;
  }
  throw new Error("expected rejection");
}

describe("normalizeHindsightBaseUrl", () => {
  it("accepts https and loopback http and strips trailing slashes", () => {
    expect(normalizeHindsightBaseUrl("https://h.example.com/api/")).toBe("https://h.example.com/api");
    expect(normalizeHindsightBaseUrl("http://127.0.0.1:8888")).toBe("http://127.0.0.1:8888");
    expect(normalizeHindsightBaseUrl("http://localhost:1")).toBe("http://localhost:1");
  });

  it("rejects remote http, credentials, query, fragment and non-URLs", () => {
    for (const bad of [
      "http://h.example.com",
      "https://user:pw@h.example.com",
      "https://h.example.com/?k=1",
      "https://h.example.com/#x",
      "ftp://h.example.com",
      "not a url",
      "",
      null,
    ]) {
      expect(() => normalizeHindsightBaseUrl(bad)).toThrow(HindsightError);
    }
  });
});

describe("hindsight client contract", () => {
  it("retains asynchronously with document id, tags, replace mode and bearer auth", async () => {
    const result = await retainDocument(target, item, "11111111-1111-5111-8111-111111111111");
    expect(result.operationId).toBe("11111111-1111-5111-8111-111111111111");
    const request = fake.requests[0];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/default/banks/bank-a/memories");
    expect(request.auth).toBe("Bearer test-token");
    expect(request.body).toMatchObject({
      async: true,
      operation_id: "11111111-1111-5111-8111-111111111111",
      items: [{ document_id: "psc-cg-1", update_mode: "replace", tags: ["psc-project:p1"] }],
    });
  });

  it("maps operation status, including 404 as not_found", async () => {
    await retainDocument(target, item, "op-1");
    expect(await getOperationStatus(target, "op-1")).toEqual({ status: "completed", failed: false });
    fake.operations.set("op-1", "failed");
    expect(await getOperationStatus(target, "op-1")).toEqual({ status: "failed", failed: true });
    expect((await getOperationStatus(target, "missing")).status).toBe("not_found");
  });

  it("recalls with all_strict tags, low budget, and drops out-of-scope facts", async () => {
    await retainDocument(target, item, "op-1");
    fake.leakFacts.push({ id: "leak", text: "other project secret", tags: ["psc-project:p2"] });
    const facts = await recallFacts(target, { query: "tags", tags: ["psc-project:p1"], maxTokens: 512 });
    expect(facts.map((fact) => fact.documentId)).toEqual(["psc-cg-1"]);
    const request = fake.requests.at(-1)!;
    expect(request.path).toBe("/v1/default/banks/bank-a/memories/recall");
    expect(request.body).toMatchObject({
      tags_match: "all_strict",
      budget: "low",
      max_tokens: 512,
      include: { entities: null },
    });
    await expect(recallFacts(target, { query: "x", tags: [], maxTokens: 512 })).rejects.toThrow(
      "requires scope tags",
    );
  });

  it("deletes only one encoded document path and reports absence", async () => {
    await retainDocument(target, { ...item, documentId: "doc/../x" }, "op-2");
    expect(await deleteDocument(target, "doc/../x")).toEqual({ found: true, memoryUnitsDeleted: 2 });
    expect(fake.requests.at(-1)!.path).toBe("/v1/default/banks/bank-a/documents/doc/../x");
    expect(await deleteDocument(target, "doc/../x")).toEqual({ found: false, memoryUnitsDeleted: 0 });
  });

  it("classifies auth, conflict, redirect, oversize, timeout and network failures without leaking secrets", async () => {
    const unauthorized = await rejects(
      retainDocument({ ...target, apiKey: "wrong-secret" }, item, "op-3"),
    );
    expect(unauthorized.kind).toBe("unauthorized");
    expect(unauthorized.message).not.toContain("wrong-secret");

    await retainDocument(target, item, "op-dup");
    expect((await rejects(retainDocument(target, item, "op-dup"))).kind).toBe("conflict");

    fake.failNext.set("POST memories/recall", 302);
    const redirect = await rejects(recallFacts(target, { query: "q", tags: ["t"], maxTokens: 128 }));
    expect(["network", "http"]).toContain(redirect.kind);
    expect(fake.requests.some((request) => request.path.includes("example.invalid"))).toBe(false);

    fake.failNext.set("GET operations/:id", -1);
    expect((await rejects(getOperationStatus(target, "op-dup"))).kind).toBe("invalid-response");

    fake.failNext.set("GET operations/:id", -2);
    const timeout = await rejects(getOperationStatus({ ...target, timeoutMs: 50 }, "op-dup"));
    expect(timeout.kind).toBe("timeout");
    expect(timeout.outcomeUnknown).toBe(true);

    const network = await rejects(
      getOperationStatus({ ...target, baseUrl: "http://127.0.0.1:1" }, "x"),
    );
    expect(network.kind).toBe("network");
    expect(network.message).not.toContain("test-token");
  });

  it("refuses an invalid bank id before sending anything", async () => {
    const error = await rejects(recallFacts({ ...target, bankId: "../all" }, { query: "q", tags: ["t"], maxTokens: 128 }));
    expect(error.kind).toBe("config");
    expect(fake.requests).toHaveLength(0);
  });

  it("honours a pre-aborted signal without a request", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await rejects(retainDocument(target, item, "op-4", controller.signal))).kind).toBe("aborted");
    expect(fake.requests).toHaveLength(0);
  });
});
