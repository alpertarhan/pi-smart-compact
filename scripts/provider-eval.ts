import { evaluateProviderMetrics, formatProviderEvaluation } from "../src/domain/provider-evaluation.ts";
import { readMetricsLog } from "../src/utils/cache.ts";

const minArg = process.argv.find(arg => arg.startsWith("--min-samples="));
const minSamples = minArg ? Number(minArg.split("=")[1]) : 5;
if (!Number.isInteger(minSamples) || minSamples < 2) {
  console.error("--min-samples must be an integer >= 2");
  process.exit(1);
}

const report = evaluateProviderMetrics(readMetricsLog(10_000), { minSamples });
console.log(process.argv.includes("--json")
  ? JSON.stringify(report, null, 2)
  : formatProviderEvaluation(report));
