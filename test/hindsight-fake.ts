/**
 * Loopback fake of the Hindsight 0.9.x HTTP routes Smart Compact uses.
 * Mirrors the real contract shapes; never contacts the network.
 */
export interface FakeRequest {
  method: string;
  path: string;
  auth: string | null;
  body: any;
}

export interface FakeDoc {
  documentId: string;
  content: string;
  tags: string[];
  metadata: Record<string, string>;
  operationId: string;
}

export interface HindsightFake {
  url: string;
  requests: FakeRequest[];
  /** Keyed by `${bank}/${documentId}`. */
  docs: Map<string, FakeDoc>;
  /** Operation status by id; retains default to `retainStatus`. */
  operations: Map<string, string>;
  retainStatus: string;
  /** Override: respond to the next request of a route with this status. */
  failNext: Map<string, number>;
  /** Extra untagged facts the server (wrongly) returns from recall. */
  leakFacts: any[];
  token: string | null;
  /** The server ignores the caller's operation id and assigns its own. */
  assignOperationIds: boolean;
  /** Runs once, after the request is recorded and before the route is handled. */
  beforeNext: Map<string, () => void>;
  stop(): void;
}

export function startHindsightFake(options: { token?: string | null } = {}): HindsightFake {
  const fake: Omit<HindsightFake, "url" | "stop"> = {
    requests: [],
    docs: new Map(),
    operations: new Map(),
    retainStatus: "completed",
    failNext: new Map(),
    leakFacts: [],
    token: options.token === undefined ? "test-token" : options.token,
    assignOperationIds: false,
    beforeNext: new Map(),
  };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
      const body = text ? JSON.parse(text) : undefined;
      fake.requests.push({
        method: request.method,
        path: decodeURIComponent(url.pathname),
        auth: request.headers.get("authorization"),
        body,
      });
      if (fake.token && request.headers.get("authorization") !== "Bearer " + fake.token) {
        return json({ detail: "unauthorized" }, 401);
      }
      const match = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)\/(.+)$/);
      if (!match) return json({ detail: "not found" }, 404);
      const route = request.method + " " + match[2].replace(/^(operations|documents)\/.+$/, "$1/:id");
      const hook = fake.beforeNext.get(route);
      fake.beforeNext.delete(route);
      hook?.();
      const forced = fake.failNext.get(route);
      // -3: process the request normally but deliver the response too late.
      const lateResponse = forced === -3;
      if (lateResponse) fake.failNext.delete(route);
      if (forced !== undefined && !lateResponse) {
        fake.failNext.delete(route);
        if (forced === 302) {
          return new Response(null, { status: 302, headers: { location: "http://example.invalid/" } });
        }
        if (forced === -1) return new Response("x".repeat(70_000), { status: 200 });
        if (forced === -2) {
          await Bun.sleep(500);
          return json({});
        }
        return json({ detail: "forced" }, forced);
      }
      const bank = decodeURIComponent(match[1]);
      if (route === "POST memories") {
        const item = body.items[0];
        if (fake.operations.has(body.operation_id)) return json({ detail: "conflict" }, 409);
        const operationId = fake.assignOperationIds ? "server-" + body.operation_id : body.operation_id;
        fake.operations.set(operationId, fake.retainStatus);
        fake.docs.set(bank + "/" + item.document_id, {
          documentId: item.document_id,
          content: item.content,
          tags: item.tags,
          metadata: item.metadata,
          operationId,
        });
        if (lateResponse) await Bun.sleep(1_500);
        return json({
          success: true,
          bank_id: decodeURIComponent(match[1]),
          items_count: 1,
          async: true,
          operation_id: operationId,
        });
      }
      if (route === "GET operations/:id") {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        const status = fake.operations.get(id);
        if (!status) return json({ detail: "not found" }, 404);
        return json({ operation_id: id, status, operation_type: "retain" });
      }
      if (route === "POST memories/recall") {
        const results = [...fake.docs.entries()]
          .filter(([key]) => key.startsWith(bank + "/"))
          .map(([, doc]) => doc)
          .filter((doc) => fake.operations.get(doc.operationId) === "completed")
          .filter((doc) => body.tags.every((tag: string) => doc.tags.includes(tag)))
          .map((doc, index) => ({
            id: "mem-" + index,
            text: doc.content,
            type: "world",
            document_id: doc.documentId,
            tags: doc.tags,
            metadata: doc.metadata,
            mentioned_at: "2026-09-24T00:00:00Z",
          }));
        return json({ results: [...results, ...fake.leakFacts] });
      }
      if (route === "DELETE documents/:id") {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        if (!fake.docs.delete(bank + "/" + id)) return json({ detail: "not found" }, 404);
        return json({ success: true, document_id: id, memory_units_deleted: 2 });
      }
      return json({ detail: "unsupported" }, 404);
    },
  });
  return Object.assign(fake, {
    url: "http://127.0.0.1:" + server.port,
    stop: () => server.stop(true),
  }) as HindsightFake;
}
