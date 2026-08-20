import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import { rawLlmClient } from "../src/infra/llm-client.ts";
import { verifySummary } from "../src/phases/verify.ts";
import type { StructuredExtraction } from "../src/types.ts";

interface Scenario {
  name: string;
  transcript: string;
  extraction: StructuredExtraction;
}

const scenarios: Scenario[] = [
  {
    name: "implementation",
    transcript: `User goal: finish JWT key rotation without new dependencies.
Decision: reuse node:crypto and preserve the existing AuthService API.
Modified files: src/auth.ts and test/auth.test.ts.
Unresolved error: expiry boundary test still fails by one second.
Latest request: fix the test, run the release gate, and do not publish.`,
    extraction: {
      mainGoal: "Finish JWT key rotation",
      messageCount: 12,
      modifiedFiles: [
        { path: "src/auth.ts", toolCalls: 2, lastModifiedIndex: 7 },
        { path: "test/auth.test.ts", toolCalls: 1, lastModifiedIndex: 9 },
      ],
      readFiles: ["package.json"],
      deletedFiles: [],
      errors: [
        {
          index: 10,
          tool: "test",
          message: "expiry boundary test still fails by one second",
          retryAttempted: true,
          resolved: false,
        },
      ],
      decisions: [
        {
          index: 4,
          type: "explicit",
          summary: "Reuse node:crypto and preserve the AuthService API",
        },
      ],
      constraints: [
        {
          index: 1,
          text: "Do not add dependencies",
          category: "prohibition",
          confidence: 1,
        },
      ],
      topics: [],
      timeline: [],
      lastUserMessages: [
        "Fix the test, run the release gate, and do not publish",
      ],
      lastErrors: [],
    },
  },
  {
    name: "debugging",
    transcript: `Goal: stop duplicate background jobs.
Read src/queue.ts and src/worker.ts; modified src/queue.ts.
Root cause found: retry scheduling happens before the idempotency key is committed.
Decision: commit the key first; keep concurrency at two.
The network timeout was resolved. Open loop: add a regression check for two simultaneous sessions.`,
    extraction: {
      mainGoal: "Stop duplicate background jobs",
      messageCount: 18,
      modifiedFiles: [
        { path: "src/queue.ts", toolCalls: 2, lastModifiedIndex: 13 },
      ],
      readFiles: ["src/queue.ts", "src/worker.ts"],
      deletedFiles: [],
      errors: [],
      decisions: [
        {
          index: 9,
          type: "explicit",
          summary: "Commit the idempotency key before retry scheduling",
        },
      ],
      constraints: [
        {
          index: 10,
          text: "Keep concurrency at two",
          category: "requirement",
          confidence: 1,
        },
      ],
      topics: [],
      timeline: [
        {
          index: 16,
          event: "open-loop",
          summary: "Add a simultaneous-session regression check",
        },
      ],
      lastUserMessages: ["Add the regression check next"],
      lastErrors: [],
    },
  },
  {
    name: "continuity",
    transcript: `Goal: prepare v8 without publishing.
Completed milestones: scoped continuity and session locking.
In progress: provider evaluation. Next: telemetry canary, then dashboard confidence.
Constraint: selected model must never change automatically; wildcard Pi peer dependencies remain.
Critical paths: src/app/run-smart-compact.ts, src/infra/llm-client.ts, scripts/eval-gate.ts.`,
    extraction: {
      mainGoal: "Prepare v8 without publishing",
      messageCount: 30,
      modifiedFiles: [
        {
          path: "src/app/run-smart-compact.ts",
          toolCalls: 2,
          lastModifiedIndex: 20,
        },
      ],
      readFiles: ["src/infra/llm-client.ts", "scripts/eval-gate.ts"],
      deletedFiles: [],
      errors: [],
      decisions: [
        {
          index: 5,
          type: "explicit",
          summary: "Do not change the selected model automatically",
        },
      ],
      constraints: [
        {
          index: 2,
          text: "Do not publish",
          category: "prohibition",
          confidence: 1,
        },
        {
          index: 6,
          text: "Keep Pi peer dependencies as wildcards",
          category: "requirement",
          confidence: 1,
        },
      ],
      topics: [],
      timeline: [
        {
          index: 28,
          event: "open-loop",
          summary: "Implement telemetry canary and dashboard confidence",
        },
      ],
      lastUserMessages: [
        "Continue provider evaluation, then telemetry and dashboard confidence",
      ],
      lastErrors: [],
    },
  },
];

const modelsArg = process.argv.find((arg) => arg.startsWith("--models="));
if (!process.argv.includes("--live") || !modelsArg) {
  console.error(
    "Live provider evaluation makes paid API calls. Use --live --models=provider/model,...",
  );
  process.exit(1);
}
const requestedModels = modelsArg
  .slice("--models=".length)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!requestedModels.length || requestedModels.length > 8) {
  console.error("Choose 1-8 models");
  process.exit(1);
}

const home = process.env.HOME ?? "";
const runtime = await ModelRuntime.create({
  authPath: home + "/.pi/agent/auth.json",
  modelsPath: home + "/.pi/agent/models.json",
  modelsStorePath: home + "/.pi/agent/models-store.json",
  allowModelNetwork: false,
});
const registry = new ModelRegistry(runtime);
const models = requestedModels.map((label) => {
  const slash = label.indexOf("/");
  const model =
    slash > 0
      ? registry.find(label.slice(0, slash), label.slice(slash + 1))
      : undefined;
  if (!model) throw new Error("Unavailable model: " + label);
  return model;
});

const systemPrompt = `Produce a faithful coding-session compaction summary. Use exactly these H2 sections:
## Goal
## Constraints & Preferences
## Progress (with H3 Done, In Progress, Blocked)
## Key Decisions
## Files Modified
## Files Read
## Next Steps
## Critical Context
Do not invent files, outcomes, or resolved work. Preserve explicit constraints, unresolved errors, and next work.`;

type Result = {
  model: string;
  scenario: string;
  score: number;
  latencyMs: number;
  input: number;
  output: number;
  error?: string;
};
const results: Result[] = [];
for (const model of models) {
  const label = model.provider + "/" + model.id;
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    for (const scenario of scenarios)
      results.push({
        model: label,
        scenario: scenario.name,
        score: 0,
        latencyMs: 0,
        input: 0,
        output: 0,
        error: "auth unavailable",
      });
    continue;
  }
  for (const scenario of scenarios) {
    console.error("Evaluating " + label + " / " + scenario.name);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("provider-eval-timeout"),
      60_000,
    );
    const start = Date.now();
    try {
      const response = await rawLlmClient.complete(
        model as Model<Api>,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: scenario.transcript }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 1_500,
          reasoning: "minimal",
          codexWatchdogMs: 60_000,
          signal: controller.signal,
        },
      );
      const summary = response.content
        .flatMap((item) =>
          item.type === "text" ? [(item as TextContent).text] : [],
        )
        .join("\n")
        .trim();
      results.push({
        model: label,
        scenario: scenario.name,
        score: verifySummary(summary, scenario.extraction).score,
        latencyMs: Date.now() - start,
        input: response.usage?.input ?? 0,
        output: response.usage?.output ?? 0,
      });
    } catch (error) {
      results.push({
        model: label,
        scenario: scenario.name,
        score: 0,
        latencyMs: Date.now() - start,
        input: 0,
        output: 0,
        error:
          error instanceof Error
            ? error.message.slice(0, 160)
            : String(error).slice(0, 160),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function tableCell(value: unknown): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

console.log("# Live Provider Scenario Matrix\n");
console.log(
  "| Model | Scenario | Verify | Latency | Input | Output | Status |",
);
console.log("|---|---|---:|---:|---:|---:|---|");
for (const result of results) {
  console.log(
    "| " +
      tableCell(result.model) +
      " | " +
      tableCell(result.scenario) +
      " | " +
      result.score +
      " | " +
      result.latencyMs +
      "ms | " +
      result.input +
      " | " +
      result.output +
      " | " +
      (result.error ? "error: " + tableCell(result.error) : "ok") +
      " |",
  );
}
console.log(
  "\nAdvisory only: stage routes stay on the selected model unless explicitly configured.",
);
