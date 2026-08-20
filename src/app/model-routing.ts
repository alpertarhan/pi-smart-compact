import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactConfig } from "../types.ts";

/** Resolve a provider/id string through the host model registry. */
export function findModelById(
  ctx: ExtensionContext,
  modelId: string,
): Model<Api> | undefined {
  const [provider, ...id] = modelId.split("/");
  return ctx.modelRegistry.find(provider, id.join("/"));
}

/** Resolve per-stage routes while preserving explicit user model precedence. */
export function resolveModels(
  ctx: ExtensionContext,
  primary: Model<Api> | undefined,
  config: CompactConfig,
  explicit = false,
): {
  segModel: Model<Api> | undefined;
  sumModel: Model<Api> | undefined;
  verifyModel: Model<Api> | undefined;
} {
  const fallback = primary ?? ctx.model;
  const available = ctx.modelRegistry.getAvailable();
  let sumModel = fallback;

  if (!explicit && config.summaryModel) {
    sumModel = findModelById(ctx, config.summaryModel) ?? sumModel;
  }
  if (!sumModel) sumModel = available[0];

  const segModel = config.segmentationModel
    ? (findModelById(ctx, config.segmentationModel) ?? sumModel)
    : sumModel;
  const verifyModel = config.verificationModel
    ? (findModelById(ctx, config.verificationModel) ?? sumModel)
    : sumModel;

  return { segModel, sumModel, verifyModel };
}
