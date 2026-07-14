import { performance } from "node:perf_hooks";
import { PROFILES } from "../src/constants.ts";
import { buildToolCallIndex, extractStructured } from "../src/utils/extraction.ts";
import { pruneRedundant } from "../src/utils/pruning.ts";
import type { LlmMessage } from "../src/types.ts";

const fullConversation: LlmMessage[] = Array.from({ length: 2_500 }, (_, i): LlmMessage[] => [
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "read-" + i, name: "read", arguments: { path: "/src/file-" + (i % 500) + ".ts" } }],
  },
  { role: "toolResult", toolCallId: "read-" + i, content: [{ type: "text", text: "export const value = " + i + ";" }] },
]).flat();
const incrementalDelta = fullConversation.slice(-100);
let sink = 0;

interface Benchmark {
  name: string;
  iterations: number;
  run: () => void;
}

const benchmarks: Benchmark[] = [
  {
    name: "incremental hit (legacy full index)",
    iterations: 20,
    run: () => {
      sink += buildToolCallIndex(fullConversation).size;
      const deltaIndex = buildToolCallIndex(incrementalDelta);
      sink += extractStructured(incrementalDelta, PROFILES.balanced, deltaIndex).messageCount;
    },
  },
  {
    name: "incremental hit (optimized)",
    iterations: 20,
    run: () => {
      const deltaIndex = buildToolCallIndex(incrementalDelta);
      sink += extractStructured(incrementalDelta, PROFILES.balanced, deltaIndex).messageCount;
    },
  },
  {
    name: "prune 5k messages",
    iterations: 5,
    run: () => { sink += pruneRedundant(fullConversation).messages.length; },
  },
];

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function measure(benchmark: Benchmark): { medianMs: number; p95Ms: number; opsPerSec: number } {
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

console.log("pi-smart-compact hot-path benchmark (5,000 messages, 100-message delta)");
console.table(benchmarks.map(benchmark => ({ name: benchmark.name, ...measure(benchmark) })));
if (sink === Number.MIN_SAFE_INTEGER) console.log(sink);
