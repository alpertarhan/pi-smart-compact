import { performance } from "node:perf_hooks";
import { PROFILES } from "../src/constants.ts";
import {
  buildToolCallIndex,
  extractStructured,
} from "../src/utils/extraction.ts";
import { pruneRedundant } from "../src/utils/pruning.ts";
import { parseSummary } from "../src/domain/summary-parse.ts";
import {
  buildKnownPathReferenceIndex,
  buildPathNeedleOwnershipIndex,
  buildUniquePathNeedles,
} from "../src/utils/file-needles.ts";
import { extractFileRefs } from "../src/utils/file-ref-detect.ts";
import { chunkLlmMessages } from "../src/phases/synthesize.ts";
import { verifySummary } from "../src/phases/verify.ts";
import { resolveProviderWatchdogMs } from "../src/infra/llm-client.ts";
import { makeTokenEstimator } from "../src/utils/tokens.ts";
import type { LlmMessage, StructuredExtraction } from "../src/types.ts";
import { serializeConversationText } from "../src/infra/ai-messages.ts";

const fullConversation: LlmMessage[] = Array.from(
  { length: 2_500 },
  (_, i): LlmMessage[] => [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read-" + i,
          name: "read",
          arguments: { path: "/src/file-" + (i % 500) + ".ts" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "read-" + i,
      content: [{ type: "text", text: "export const value = " + i + ";" }],
    },
  ],
).flat();
// Message count alone hid multi-megabyte tool-result regressions. Include
// distinct file reads, mixed Unicode/log output, failures, and tail evidence.
const largeConversation: LlmMessage[] = Array.from({ length: 500 }, (_, i): LlmMessage[] => [
  { role: "assistant", content: [{ type: "toolCall", id: "large-" + i, name: "read", arguments: { path: "src/file-" + i + ".ts" } }] },
  { role: "toolResult", toolCallId: "large-" + i, toolName: "read", isError: i % 10 === 0,
    content: [{ type: "text", text: ("line " + i + ": ölçüm output value;\n").repeat(1600).slice(0, 40_000) + "END-EVIDENCE-" + i }] },
]).flat();
const incrementalDelta = fullConversation.slice(-100);
const oneMegabyteSummary = "## Goal\n" + "x".repeat(1_000_000);
const longDotlessToken = "x".repeat(24_000);
const longLeadingDotToken = ".a" + "x".repeat(24_000);
const longUnicodePath = "é".repeat(16_000) + "/Auth.ts";
const deepSlashPath = "a/".repeat(8_000) + "Auth.ts";
const collidingPaths = Array.from(
  { length: 500 },
  (_, i) => "packages/p" + i + "/src/index.ts",
);
const estimator = makeTokenEstimator("openai", "benchmark");
const verificationFiles = Array.from(
  { length: 500 },
  (_, index) => "packages/p" + index + "/src/index.ts",
);
const verificationExtraction: StructuredExtraction = {
  modifiedFiles: verificationFiles.map((path, index) => ({
    path,
    toolCalls: 1,
    lastModifiedIndex: index,
  })),
  readFiles: [],
  deletedFiles: [],
  errors: [],
  decisions: [],
  constraints: [],
  topics: [],
  timeline: [],
  mainGoal: "Refactor package entry points",
  lastUserMessages: [],
  lastErrors: [],
  messageCount: 1_000,
};
const verificationSummary = [
  "## Goal\nRefactor package entry points",
  "## Progress\n### Done\n- Updated 500 package entry points\n### In Progress\n- nothing\n### Blocked\n- nothing",
  "## Files Modified\n" +
    verificationFiles.map((path) => "- " + path).join("\n"),
  "## Critical Context\n- none",
].join("\n");
let sink = 0;

interface Benchmark {
  name: string;
  iterations: number;
  run: () => void;
}

interface Measurement {
  medianMs: number;
  p95Ms: number;
  opsPerSec: number;
}

const P95_LIMIT_MS: Record<string, number> = {
  "incremental hit (legacy full index)": 5,
  "incremental hit (optimized)": 3,
  "prune 5k messages": 30,
  "prune 20MB tool history": 1_000,
  "extract 20MB tool history": 1_000,
  "serialize 20MB backup text": 250,
  "chunk + bound 5k messages": 40,
  "parse 1MB canonical summary": 5,
  "scan 24k dotless file-ref token": 5,
  "scan 24k leading-dot file-ref token": 5,
  "index 16k unicode path": 20,
  "index 8k-segment path ownership": 20,
  "unique needles across 500 paths": 2,
  "verify 500 grounded paths": 50,
  "resolve provider watchdog profile": 0.1,
};

const benchmarks: Benchmark[] = [
  { name: "prune 20MB tool history", iterations: 1, run: () => { sink += pruneRedundant(largeConversation).messages.length; } },
  { name: "extract 20MB tool history", iterations: 1, run: () => { sink += extractStructured(largeConversation, PROFILES.balanced).messageCount; } },
  { name: "serialize 20MB backup text", iterations: 1, run: () => {
    const transcript = serializeConversationText(largeConversation);
    if (!transcript.endsWith("END-EVIDENCE-499")) throw new Error("Backup tail lost");
    sink += transcript.length;
  } },
  {
    name: "incremental hit (legacy full index)",
    iterations: 20,
    run: () => {
      sink += buildToolCallIndex(fullConversation).size;
      const deltaIndex = buildToolCallIndex(incrementalDelta);
      sink += extractStructured(
        incrementalDelta,
        PROFILES.balanced,
        deltaIndex,
      ).messageCount;
    },
  },
  {
    name: "incremental hit (optimized)",
    iterations: 20,
    run: () => {
      const deltaIndex = buildToolCallIndex(incrementalDelta);
      sink += extractStructured(
        incrementalDelta,
        PROFILES.balanced,
        deltaIndex,
      ).messageCount;
    },
  },
  {
    name: "prune 5k messages",
    iterations: 5,
    run: () => {
      sink += pruneRedundant(fullConversation).messages.length;
    },
  },
  {
    name: "chunk + bound 5k messages",
    iterations: 5,
    run: () => {
      sink += chunkLlmMessages(
        fullConversation,
        [],
        PROFILES.balanced,
        estimator,
      ).length;
    },
  },
  {
    name: "parse 1MB canonical summary",
    iterations: 5,
    run: () => {
      sink += parseSummary(oneMegabyteSummary).sections[0]?.body.length ?? 0;
    },
  },
  {
    name: "scan 24k dotless file-ref token",
    iterations: 20,
    run: () => {
      sink += extractFileRefs(longDotlessToken).length;
    },
  },
  {
    name: "scan 24k leading-dot file-ref token",
    iterations: 20,
    run: () => {
      sink += extractFileRefs(longLeadingDotToken).length;
    },
  },
  {
    name: "index 16k unicode path",
    iterations: 5,
    run: () => {
      sink += buildKnownPathReferenceIndex([longUnicodePath]).boundarySuffixes.size;
    },
  },
  {
    name: "index 8k-segment path ownership",
    iterations: 5,
    run: () => {
      sink += buildPathNeedleOwnershipIndex([deepSlashPath]).counts.size;
    },
  },
  {
    name: "unique needles across 500 paths",
    iterations: 20,
    run: () => {
      sink += buildUniquePathNeedles(
        collidingPaths[250],
        collidingPaths,
      ).length;
    },
  },
  {
    name: "verify 500 grounded paths",
    iterations: 1,
    run: () => {
      sink += verifySummary(verificationSummary, verificationExtraction).score;
    },
  },
  {
    name: "resolve provider watchdog profile",
    iterations: 1_000,
    run: () => {
      sink += resolveProviderWatchdogMs("kimi-coding", 8_192);
    },
  },
];

function percentile(sorted: number[], ratio: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
  );
}

function measure(benchmark: Benchmark): Measurement {
  for (let i = 0; i < 5; i++) benchmark.run();
  const samples: number[] = [];
  for (let sample = 0; sample < 25; sample++) {
    const start = performance.now();
    for (let i = 0; i < benchmark.iterations; i++) benchmark.run();
    samples.push((performance.now() - start) / benchmark.iterations);
  }
  samples.sort((a, b) => a - b);
  const medianMs = percentile(samples, 0.5);
  return {
    medianMs: Number(medianMs.toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    opsPerSec: Math.round(1_000 / medianMs),
  };
}

console.log(
  "pi-smart-compact hot-path benchmark (5,000 messages, 100-message delta, 20MB tool history)",
);
const measurements = benchmarks.map((benchmark) => ({
  name: benchmark.name,
  ...measure(benchmark),
}));
console.table(measurements);
const regressions = measurements.filter(
  (result) => result.p95Ms > P95_LIMIT_MS[result.name],
);
if (regressions.length) {
  throw new Error(
    "Hot-path benchmark regression: " +
      regressions
        .map(
          (result) =>
            result.name +
            " p95=" +
            result.p95Ms +
            "ms > " +
            P95_LIMIT_MS[result.name] +
            "ms",
        )
        .join("; "),
  );
}
if (sink === Number.MIN_SAFE_INTEGER) console.log(sink);
