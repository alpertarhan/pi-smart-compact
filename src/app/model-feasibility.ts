import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactConfig, CompactionMode, CompactionState, LlmMessage, ProfileConfig, StructuredExtraction } from "../types.ts";
import { modelRequestCapacityReason } from "../domain/model-capacity.ts";
import { SecretScrubber } from "../domain/scrub.ts";
import { createProductionServices } from "../infra/services.ts";
import { isUnresolvedSessionId, resolveSessionId } from "../infra/session-identity.ts";
import { scrubLlmMessages, serializeConversationText } from "../infra/ai-messages.ts";
import { loadCachedExtraction } from "../utils/cache.ts";
import { estimateTokens } from "../utils/tokens.ts";
import { pruneRedundant } from "../utils/pruning.ts";
import { createBatches, getPreviousCompactionContext } from "../utils/helpers.ts";
import { resolveModels } from "./model-routing.ts";
import { planManualPreflight, preflightDamageMedian, prepareManualPreflightContext, preparePreflightProfile } from "./preflight.ts";
import { batchOutputLimit, continuityRisk, deterministicExtractionConfidence, MODE_POLICIES, resolveMode } from "./mode-policy.ts";
import { recoverSourceMessages } from "./steps/recover.ts";
import { loadExtractionContinuity, selectCachedExtraction } from "./steps/extract.ts";
import { buildBatchRequest, buildSinglePassRequest, chunkLlmMessages, heuristicTopicBoundaries, type SynthesisRequest } from "../phases/synthesize.ts";
import { buildDirectExplorationRequest, buildExplorerRequest, explorationToolSupportKey, shouldExplore } from "../phases/explore.ts";
import { buildPatchRequest } from "../phases/verify.ts";

export interface ModelEligibility { selectable: boolean; reason?: string }

export type ModelFeasibility = (
 model: Model<Api>, stage: "summary" | "segmentation" | "verification", mode?: CompactionMode,
) => ModelEligibility;

interface PreparedPrefix {
 messages: LlmMessage[];
 extraction: StructuredExtraction;
 convText: string;
 prevContext: string;
 projectContext: string;
 previousState: CompactionState | null;
}

interface SummaryRequestPlan {
 data: PreparedPrefix;
 requests: Array<{ phase: string; request: SynthesisRequest }>;
 explore: boolean;
}

/**
 * Read the branch/source log once, then lazily inspect the real planned requests.
 * This is not a whole-conversation window test: hierarchical EESV sends batches.
 * No auth resolution, metrics, cache writes, migrations, or memory-backend calls.
 * Recreate after a branch/config/mode change. Generated follow-ups are unknowable
 * here; trackedComplete revalidates every concrete request before dispatch.
 */
export async function createModelFeasibilityResolver(
 ctx: ExtensionContext,
 config: CompactConfig,
 requestedMode: CompactionMode = config.mode,
 steering: { focus?: string; userNote?: string } = {},
): Promise<ModelFeasibility> {
 const sessionId = resolveSessionId(ctx);
 const selectedSummary = resolveModels(ctx, ctx.model, config).sumModel;
 if (isUnresolvedSessionId(sessionId) || !selectedSummary) {
  return () => ({ selectable: false, reason: "A session and a locally configured model are required before request sizes can be checked." });
 }
 const services = createProductionServices({ scrubber: new SecretScrubber(config.scrubSecrets, config.scrubPii) });
 const shared = prepareManualPreflightContext(ctx, selectedSummary, services.tokenCalibration);
 const recovered = await recoverSourceMessages(sessionId, shared.msgs, ctx.cwd);
 const cachedExt = loadCachedExtraction(sessionId, { readOnly: true });
 const damageMedian = preflightDamageMedian(ctx.cwd, config);
 const previousCompaction = getPreviousCompactionContext(shared.branch);
 const prefixes = new Map<string, PreparedPrefix>();

 function prefix(keepFrom: number, profileCfg: ProfileConfig, profileName: string): PreparedPrefix {
  const key = profileName + ":" + keepFrom;
  const existing = prefixes.get(key);
  if (existing) return existing;
  const currentEntryIds = shared.msgs.slice(0, keepFrom).map(entry => entry.id);
  const ids = new Set(currentEntryIds);
  const source = recovered.messages.filter(item => ids.has(item.entryId));
  const pruning = pruneRedundant(source.map(item => item.message));
  const currentKeptEntryIds = pruning.keptIndices.map(index => source[index].entryId);
  const messages = scrubLlmMessages(pruning.messages, services.scrubber);
  const extraction = services.scrubber.scrubValue(selectCachedExtraction({
   llmMessages: messages, profileCfg, currentEntryIds, currentKeptEntryIds, cachedExt,
  }).extraction).value;
  const continuity = loadExtractionContinuity({
   cwd: ctx.cwd, branch: shared.branch, sessionId, llmMessages: messages,
  }, extraction, { readOnly: true });
  const prepared: PreparedPrefix = {
   messages, extraction,
   convText: services.scrubber.scrubText(serializeConversationText(messages)).value,
   prevContext: [previousCompaction, continuity.continuity].filter(Boolean).join("\n\n"),
   projectContext: continuity.projectCtx,
   previousState: continuity.previousState,
  };
  prefixes.set(key, prepared);
  return prepared;
 }

 function plan(model: Model<Api>, modePreference: CompactionMode): SummaryRequestPlan {
  const initialMode = resolveMode(modePreference, shared.contextPercent);
  const prepared = preparePreflightProfile({ cwd: ctx.cwd, summaryModel: model, mode: initialMode, tokenCalibration: services.tokenCalibration, config, damageMedian });
  const messageTokens = shared.msgs.map(entry => prepared.estimator.message(entry.message as LlmMessage));
  const preview = planManualPreflight(ctx, model, initialMode, services.tokenCalibration, config, damageMedian, {
   ...shared, messageTokens, rawEstimatedMessageTokens: messageTokens.reduce((sum, count) => sum + count, 0),
  });
  const data = prefix(preview.plan?.keepFrom ?? 0, prepared.profileCfg, MODE_POLICIES[initialMode].profile);
  const mode = resolveMode(modePreference, shared.contextPercent, data.extraction, continuityRisk(data.previousState) + (prepared.adapted ? 12 : 0));
  const convTokens = prepared.estimator.text(data.convText);
  const zeroCall = config.zeroCallEnabled !== false && mode === "fast" && !steering.focus && !steering.userNote &&
   deterministicExtractionConfidence(data.extraction, { conversationTokens: convTokens, toolPercent: shared.toolPercent }) >= 0.85;
  const singlePassLimit = Math.round(prepared.profileCfg.singlePassMaxTokens * prepared.providerCaps.singlePassTokenMultiplier * MODE_POLICIES[mode].singlePassMultiplier);
  const single = convTokens < singlePassLimit;
  const requests: Array<{ phase: string; request: SynthesisRequest }> = [];
  if (!zeroCall) {
   if (single) {
    requests.push({ phase: "Single-pass summary", request: buildSinglePassRequest(data.convText, data.extraction, null, data.prevContext + data.projectContext, model, prepared.profileCfg.summaryBudgetTokens, config.focusWeighting ? steering.focus : undefined) });
   } else {
    const chunks = chunkLlmMessages(data.messages, heuristicTopicBoundaries(data.extraction), prepared.profileCfg, prepared.estimator, config.focusWeighting ? steering.focus : undefined);
    const batches = createBatches(chunks, prepared.profileCfg.batchMaxTokens);
    for (let index = 0; index < batches.length; index++) {
     const batch = batches[index];
     requests.push({ phase: `Summary batch ${index + 1}/${batches.length}`, request: buildBatchRequest(batch, data.extraction, model, batchOutputLimit(mode, batch.length, prepared.providerCaps.maxOutputTokens)) });
    }
   }
  }
  return { data, requests, explore: !zeroCall && !single && MODE_POLICIES[mode].explore && shouldExplore(data.extraction) };
 }

 const plans = new Map<CompactionMode, Map<Model<Api>, SummaryRequestPlan>>();
 function summaryPlan(model: Model<Api>, modePreference: CompactionMode) {
  let models = plans.get(modePreference);
  if (!models) { models = new Map(); plans.set(modePreference, models); }
  let current = models.get(model);
  if (!current) { current = plan(model, modePreference); models.set(model, current); }
  return current;
 }
 function capacity(model: Model<Api>, phase: string, request: SynthesisRequest): ModelEligibility {
  const safeRequest = services.scrubber.scrubValue(request.context).value;
  const input = estimateTokens(JSON.stringify(safeRequest), model.provider, model.id, services.tokenCalibration);
  const reason = modelRequestCapacityReason(model, input, request.maxTokens);
  return reason ? { selectable: false, reason: `${phase}: ${reason}` } : { selectable: true };
 }
 function explorationCapacity(model: Model<Api>, data: PreparedPrefix): ModelEligibility {
  const direct = services.toolSupport.get(explorationToolSupportKey(model), services.clock.now()) === false;
  const request = direct
   ? buildDirectExplorationRequest(data.messages, data.extraction, model, data.prevContext, steering.userNote)
   : buildExplorerRequest(data.extraction, model, data.prevContext, steering.userNote);
  return capacity(model, direct ? "Direct exploration" : "First exploration request", request);
 }

 return (model, stage, modePreference = requestedMode) => {
  const invalid = modelRequestCapacityReason(model, 0, 0);
  if (invalid) return { selectable: false, reason: invalid };
  if (stage === "summary") {
   const current = summaryPlan(model, modePreference);
   for (const item of current.requests) {
    const checked = capacity(model, item.phase, item.request);
    if (!checked.selectable) return checked;
   }
   if (current.explore) {
    const explorationModel = resolveModels(ctx, model, config, true).segModel ?? model;
    return explorationCapacity(explorationModel, current.data);
   }
   return { selectable: true };
  }
  if (stage === "segmentation") {
   const current = summaryPlan(selectedSummary, modePreference);
   if (!current.explore) return { selectable: true, reason: "Exploration is not used by the current plan; a future plan is checked again." };
   return explorationCapacity(model, current.data);
  }
  // Findings and the new summary do not exist yet. Check the fixed request
  // floor, never pretend a guessed future repair payload is the real one.
  const checked = capacity(model, "Repair request minimum", buildPatchRequest("", [], model));
  return checked.selectable
   ? { selectable: true, reason: "Repair input depends on the generated summary and findings; it is checked before dispatch." }
   : checked;
 };
}
