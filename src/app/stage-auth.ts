import type { PreparedRc, ResolvedAuth } from "./run-context.ts";

/**
 * Race a pending auth resolution against the run's cancellation. Mirrors
 * `withProviderDeadline`: a host abort or hard deadline must settle the
 * stage immediately instead of pinning the run lock until the registry
 * answers. The registry call is taken as an invocation callback and its
 * promise always gets handlers attached, so a rejection (including one
 * caused by the same abort racing it) can never surface as an unhandled
 * rejection; the listener is removed in every completion path, so a late
 * resolution can neither leak it nor re-enter a run that unwound as
 * cancelled.
 */
function abortableAuth<T>(
 invoke: () => Promise<T>,
 signal: AbortSignal,
): Promise<T> {
 return new Promise<T>((resolve, reject) => {
  const auth = invoke();
  const onAbort = () =>
   reject(signal.reason ?? new Error("Stage auth aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  auth.then(
   (value) => {
    signal.removeEventListener("abort", onAbort);
    resolve(value);
   },
   (error) => {
    signal.removeEventListener("abort", onAbort);
    reject(error);
   },
  );
 });
}

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

  // An already-aborted run must not even ask the registry (no provider
  // probes, no lock pinning); an abort during the await settles the stage
  // with the cancellation reason so the caller's throwIfAborted unwind wins.
  rc.cancellation.signal.throwIfAborted();
  const auth = await abortableAuth(
   () => rc.ctx.modelRegistry.getApiKeyAndHeaders(model),
   rc.cancellation.signal,
  );
  if (!auth.ok || !auth.apiKey) {
   throw new Error("Authentication unavailable for " + stage + " route " + model.provider + "/" + model.id);
  }
  const resolved = { apiKey: auth.apiKey, headers: auth.headers };
  // A resolution racing an abort belongs to a run that already unwound as
  // cancelled: do not cache it into the stage for a later resurrection.
  rc.cancellation.signal.throwIfAborted();
  if (stage === "summary") rc.summaryAuth = resolved;
  else if (stage === "explore") rc.segAuth = resolved;
  else rc.verifyAuth = resolved;
  return resolved;
}
