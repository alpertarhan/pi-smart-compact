import type { PreparedRc, ResolvedAuth } from "./run-context.ts";

export async function resolveStageAuth(
  rc: PreparedRc,
  stage: "summary" | "explore" | "verify",
): Promise<ResolvedAuth> {
  const model = stage === "summary" ? rc.summaryModel : stage === "explore" ? rc.segModel : rc.verifyModel;
  const existing = stage === "summary" ? rc.summaryAuth : stage === "explore" ? rc.segAuth : rc.verifyAuth;
  if (existing) return existing;

  const routes = [
    { model: rc.summaryModel, auth: rc.summaryAuth },
    { model: rc.segModel, auth: rc.segAuth },
    { model: rc.verifyModel, auth: rc.verifyAuth },
  ];
  const shared = routes.find(route => route.auth
    && route.model.provider === model.provider && route.model.id === model.id)?.auth;
  if (shared) {
    if (stage === "summary") rc.summaryAuth = shared;
    else if (stage === "explore") rc.segAuth = shared;
    else rc.verifyAuth = shared;
    return shared;
  }

  const auth = await rc.ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error("Authentication unavailable for " + stage + " route " + model.provider + "/" + model.id);
  }
  const resolved = { apiKey: auth.apiKey, headers: auth.headers };
  if (stage === "summary") rc.summaryAuth = resolved;
  else if (stage === "explore") rc.segAuth = resolved;
  else rc.verifyAuth = resolved;
  return resolved;
}
