import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUTO_TRIGGER_TIMEOUT_CAP_MS, LARGE_CONTEXT_WINDOW_TOKENS, MIN_TOKEN_THRESHOLD, SETTLED_TRIGGER_COOLDOWN_MS, FIVE_MINUTES_MS } from "../constants.ts";
import { isChatGptCodex } from "../infra/llm-client.ts";
import { isNativeApi } from "../infra/native-protocol.ts";
import { componentInstalled, installCommand } from "../infra/optional-components.ts";
import { contextGraphFile, home } from "../infra/paths.ts";
import { isUnresolvedSessionId, resolveSessionId } from "../infra/session-identity.ts";
import type { CompactConfig } from "../types.ts";
import { readMetricsLog } from "../utils/cache.ts";
import { deriveProjectIdFromCwd } from "../utils/fingerprint.ts";
import { effectiveContextWindow } from "../utils/tokens.ts";
import { preparationWindow } from "./background-preparation.ts";
import { resolveHindsightTarget } from "./hindsight-memory.ts";
import { mnemopiTarget } from "./mnemopi-memory.ts";
import { resolveModels } from "./model-routing.ts";
import type { SmartCompactPolicySnapshot } from "./smart-compact-policy.ts";
import { describeMemoryBackendReadiness, type MemoryBackendReadiness } from "./memory-backend.ts";
import type { ModelFeasibility } from "./model-feasibility.ts";

export interface EffectiveRuntimeState {
  running: boolean;
  preparation: "idle" | "preparing" | "ready";
  paused: boolean;
  /** Host prompt-cache ledger lines for the current session, when attached. */
  cacheLedger?: string[];
}
export interface EffectiveReadiness {
  canCompact: boolean;
  blockers: string[];
  warnings: string[];
  memory: MemoryBackendReadiness;
}

/** Read-only local checks. Memory is optional and never blocks compaction. */
export async function describeReadiness(
  ctx: ExtensionContext,
  config: CompactConfig,
  runtime?: EffectiveRuntimeState,
  feasibility?: ModelFeasibility,
): Promise<EffectiveReadiness> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const available = ctx.modelRegistry.getAvailable();
  const credentialsPresent = (model: Model<Api> | undefined): boolean => Boolean(model && available.some(
    candidate => candidate.provider === model.provider && candidate.id === model.id,
  ));
  if (isUnresolvedSessionId(resolveSessionId(ctx))) blockers.push("Session identity is unavailable. Open or resume a Pi session first.");
  if (!ctx.model) blockers.push("Choose a chat model in Pi before compacting.");
  if (runtime?.paused) blockers.push("A context pivot is pending. Finish or cancel it before compacting.");
  if (runtime?.running) blockers.push("A compaction is already running. Wait for it to finish.");
  const { sumModel } = resolveModels(ctx, ctx.model, config);
  const eesvCapacity = sumModel && feasibility?.(sumModel, "summary");
  const eesvReady = config.compactionEngines.includes("eesv") && credentialsPresent(sumModel) && eesvCapacity?.selectable !== false;
  const nativeReady = config.compactionEngines.includes("native") && ctx.model && isNativeApi(ctx.model.api) && credentialsPresent(ctx.model);
  if (!eesvReady && !nativeReady) {
    if (!available.length) blockers.push("No model credentials are available. Use /login or configure a provider API key.");
    else if (config.compactionEngines.includes("eesv") && eesvCapacity?.selectable === false) blockers.push("Summary model: " + (eesvCapacity.reason ?? "the planned request does not fit").replace(/[.\s]+$/, "") + ". Choose another model in Models.");
    else if (config.compactionEngines.includes("eesv")) blockers.push("The summary model has no credentials. Choose an available model in Models.");
    else blockers.push("The current chat model has no supported native route. Choose verified text or change the chat model.");
  }
  if (nativeReady) warnings.push("Native route recognized locally; provider acceptance and billing are not verified.");
  if (eesvReady) warnings.push("Request sizes are locally estimated; generated follow-up requests are checked again before dispatch.");
  if (config.autoTrigger && config.autoTriggerStrategy === "native-hook") {
    warnings.push("Automatic compaction runs only when Pi starts it; PSC cannot check whether Pi automatic compaction is on. In Settings, choose Start when \"When idle\" to run independently.");
  }
  const window = ctx.model?.contextWindow;
  if (config.autoTrigger && typeof window === "number" && Number.isFinite(window) && window > LARGE_CONTEXT_WINDOW_TOKENS
    && effectiveContextWindow(ctx.model, config) === window) {
    warnings.push("Model window " + window.toLocaleString("en-US") + " tokens; maxContextTokens is off, so automatic compaction waits for "
      + config.minContextPercent + "% of the full window. Set maxContextTokens to trigger earlier.");
  }
  const memory = await describeMemoryBackendReadiness(config);
  if (!memory.ready) warnings.push("Memory: " + memory.reason + " Compaction can still run.");
  if (config.visualArchiveEnabled && !componentInstalled("resvg")) {
    warnings.push("Image snapshots: the optional @resvg/resvg-js component is not installed, so snapshots fall back to text. Install it with: " + installCommand(["resvg"]));
  }
  return { canCompact: blockers.length === 0, blockers, warnings, memory };
}


function label(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200) : "unknown";
}

function displayPath(file: string): string {
  const prefix = home() + path.sep;
  return label(file.startsWith(prefix) ? "~/" + file.slice(prefix.length) : file);
}


/** Local evidence, not a connectivity/authentication probe; never acquire a lease or create a store. */
export async function describeEffectiveState(
  ctx: ExtensionContext,
  config: CompactConfig,
  policy: SmartCompactPolicySnapshot,
  runtime?: EffectiveRuntimeState,
): Promise<string> {
  const available = ctx.modelRegistry.getAvailable();
  const { sumModel, segModel, verifyModel } = resolveModels(ctx, ctx.model, config);
  const hasCredentials = (model: Model<Api> | undefined): boolean => Boolean(model && available.some(
    candidate => candidate.provider === model.provider && candidate.id === model.id,
  ));
  const route = (name: string, model: Model<Api> | undefined, configured: string | null = null): string => {
    if (!model) return name + ": unavailable";
    const effective = model.provider + "/" + model.id;
    return name + ": " + label(effective) + (hasCredentials(model) ? " (credentials present, not verified)" : " (credentials unavailable)")
      + (configured && configured !== effective ? "; configured " + label(configured) + " not found, using fallback" : "");
  };
  const sessionId = resolveSessionId(ctx);
  const projectId = deriveProjectIdFromCwd(ctx.cwd);
  const lines = ["Effective state — local evidence only", "Engine order: " + config.compactionEngines.join(" → "), route("Reader", ctx.model)];
  if (config.compactionEngines.includes("native")) {
    lines.push("Native: " + (ctx.model && isNativeApi(ctx.model.api) ? "API eligible; endpoint support not verified" : "current reader API is not supported")
      + "; no hard output-budget guarantee");
  }
  if (config.compactionEngines.includes("eesv")) {
    lines.push(route("Summary", sumModel, config.summaryModel), route("Segmentation", segModel, config.segmentationModel),
      route("Verification", verifyModel, config.verificationModel));
    const codex = [sumModel, segModel, verifyModel].some(model => model && isChatGptCodex(model));
    lines.push(codex
      ? "EESV output: ChatGPT/Codex has no provider hard cap; watchdog " + (config.codexMaxCallMs ? config.codexMaxCallMs + " ms" : "auto (15–90 s)") + " is client-side only"
      : "EESV output: maxTokens requested; wire/provider enforcement is not verified here");
  }
  const reasons: string[] = [];
  if (!policy.autoTrigger) reasons.push(config.autoTrigger ? "disabled by branch policy" : "disabled in configuration");
  if (isUnresolvedSessionId(sessionId)) reasons.push("session identity unavailable");
  if (!ctx.model) reasons.push("reader unavailable");
  if (!available.length) reasons.push("no model credentials available; use /login or a provider API key");
  if (runtime?.paused) reasons.push("context pivot pending");
  if (runtime?.running) reasons.push("compaction already running");
  const hostDriven = config.autoTriggerStrategy === "native-hook";
  lines.push("PSC auto: " + (policy.autoTrigger ? "on" : "off") + " · " + config.autoTriggerStrategy
    + (reasons.length ? " — " + reasons.join("; ")
      : hostDriven ? " — host-driven: acts only when Pi's own auto-compaction fires (threshold or overflow)"
        : " — PSC starts compaction when idle, subject to pressure and cooldown gates; Pi's auto-compaction setting is not needed"));
  // Pi exposes no public read of its compaction setting; only the hook event proves it fired.
  if (policy.autoTrigger && hostDriven) {
    lines.push("Pi auto-compaction: unknown — extensions cannot read Pi's compaction setting; if it is off, nothing compacts automatically. Start when \"When idle\" works without it.");
  }
  lines.push("Agent tool: " + (policy.agentToolEnabled ? "exposed" : "not exposed") + " (policy " + policy.agentToolAccess + ")");
  if (ctx.model && !ctx.model.promptCache) lines.push("Reader prompt-cache lifetime: not declared; host cache warming cannot schedule from this metadata. No cache savings are assumed.");
  const window = ctx.model?.contextWindow;
  const gateWindow = effectiveContextWindow(ctx.model, config);
  const tokens = ctx.getContextUsage()?.tokens;
  if (typeof window === "number" && Number.isFinite(window) && window > 0 && typeof gateWindow === "number") {
    const gates = preparationWindow(config, gateWindow);
    const apply = Math.ceil(Math.max(MIN_TOKEN_THRESHOLD, gates.applyTokens)).toLocaleString("en-US");
    const gate = " (" + config.minContextPercent + "% of " + (gateWindow < window ? "maxContextTokens " : "window ")
      + gateWindow.toLocaleString("en-US") + ", floor " + MIN_TOKEN_THRESHOLD.toLocaleString("en-US") + ")";
    lines.push("Context: " + (typeof tokens === "number" && Number.isFinite(tokens) ? Math.ceil(tokens).toLocaleString("en-US") : "unknown")
      + "/" + window.toLocaleString("en-US") + " tokens; " + (!policy.autoTrigger ? "automatic compaction off"
        : hostDriven ? "Pi decides when; PSC replaces Pi's threshold summary only ≥" + apply + gate + ", overflow skips the % gate"
          : "PSC starts ≥" + apply + gate));
    if (policy.autoTrigger && config.autoTriggerStrategy === "background") {
      lines.push(gates.startTokens < gates.applyTokens
        ? "Prepare window: ≥" + Math.ceil(gates.startTokens).toLocaleString("en-US") + " and <" + Math.ceil(gates.applyTokens).toLocaleString("en-US") + " tokens"
        : "Prepare window: unavailable under the current window/thresholds");
    }
  } else lines.push("Context/apply gates: unavailable without a valid reader window");
  lines.push("Runtime: " + (runtime ? (runtime.running ? "running" : "idle") + "; preparation " + runtime.preparation : "not attached")
    + "; candidate reuse is revalidated at apply");
  if (runtime?.cacheLedger?.length) lines.push(...runtime.cacheLedger);
  lines.push("Auto limits: " + Math.min(config.autoTriggerTimeoutMs, AUTO_TRIGGER_TIMEOUT_CAP_MS) / 1_000
    + " s timeout; " + SETTLED_TRIGGER_COOLDOWN_MS / 60_000 + " min cooldown; " + FIVE_MINUTES_MS / 60_000 + " min preparation TTL");
  const backgroundHygiene = policy.autoTrigger && config.autoTriggerStrategy === "background";
  lines.push("Context hygiene: " + (config.contextHygieneEnabled ? "on (explicit: commits under pressure, at cache break-even, or on a cold cache)"
    : backgroundHygiene ? "on (enabled by effective background strategy, pressure-gated)" : "off")
    + ((config.contextHygieneEnabled || backgroundHygiene) && config.toolLoading === "off" ? " — automatic trims inactive: agent tools are off, so archived output could not be read back" : ""));
  const memory = await describeMemoryBackendReadiness(config);
  lines.push("Memory selected: " + config.memoryBackend + (projectId ? " (project-bound)" : " — unavailable: no project scope"));
  lines.push("Memory readiness: " + memory.reason);
  if (config.memoryBackend === "mnemopi" && projectId) {
    lines.push("Store: " + displayPath(mnemopiTarget(config, projectId).dbPath));
  } else if (config.memoryBackend === "hindsight") {
    const target = resolveHindsightTarget(config);
    if ("ok" in target && target.ok) lines.push("Existing server: " + label(target.target.baseUrl) + "; bank " + label(target.target.bankId));
    lines.push("Hindsight only: no local graph/Mnemopi access or fallback; no server is installed.");
  } else if (config.memoryBackend === "local") {
    lines.push("Store: " + displayPath(contextGraphFile()));
  }
  lines.push("Local graph: " + (memory.localOpsAllowed ? "active" : "inactive") + "; changing backend leaves other stores untouched and inactive");
  if (config.visualArchiveEnabled) {
    lines.push("Image snapshots: renderer @resvg/resvg-js " + (componentInstalled("resvg") ? "installed" : "not installed (text fallback; install it with: " + installCommand(["resvg"]) + ")"));
  }
  const last = isUnresolvedSessionId(sessionId) ? undefined : readMetricsLog(200).findLast(entry => entry?.sessionId === sessionId);
  lines.push(last ? "Last session record: " + label(last.ts) + " · " + label(last.status) + " · " + label(last.method)
    : "Last session record: none in the recent local log");
  return lines.join("\n");
}
