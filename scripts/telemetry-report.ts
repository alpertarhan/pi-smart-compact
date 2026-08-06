import { VERSION } from "../src/constants.ts";
import {
  buildPrivacySafeTelemetry, formatPrivacySafeTelemetry, type DamageTelemetryEntry,
} from "../src/domain/telemetry.ts";
import { readJsonlTail } from "../src/infra/fs.ts";
import { damageReportsFile } from "../src/infra/paths.ts";
import { readMetricsLog } from "../src/utils/cache.ts";

const minArg = process.argv.find(arg => arg.startsWith("--min-canary-runs="));
const minCanaryRuns = minArg ? Number(minArg.split("=")[1]) : 20;
if (!Number.isInteger(minCanaryRuns) || minCanaryRuns < 5) {
  console.error("--min-canary-runs must be an integer >= 5");
  process.exit(1);
}
const report = buildPrivacySafeTelemetry(
  readMetricsLog(10_000),
  readJsonlTail<DamageTelemetryEntry>(damageReportsFile(), 10_000),
  { version: VERSION, minCanaryRuns },
);
console.log(process.argv.includes("--json")
  ? JSON.stringify(report, null, 2)
  : formatPrivacySafeTelemetry(report));
