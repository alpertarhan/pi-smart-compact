/** Proactive auto-compaction request that delegates all EESV work to Pi's host lifecycle. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactConfig } from "../types.ts";
import { MIN_TOKEN_THRESHOLD, SETTLED_TRIGGER_COOLDOWN_MS } from "../constants.ts";
import { isUnresolvedSessionId, resolveSessionId } from "../infra/session-identity.ts";
import { safeContextPercent } from "../utils/tokens.ts";
import { errorDetail, reportIssue } from "../utils/issues.ts";

export interface SettledAutoTrigger {
  request(ctx: ExtensionContext, config: CompactConfig): Promise<void>;
  noteCompaction(sessionId: string): void;
  clear(sessionId: string): void;
}

export interface SettledAutoTriggerOptions {
  now?: () => number;
  cooldownMs?: number;
}

/**
 * Keep proactive triggering deliberately thin: it requests a normal host
 * compaction and never runs EESV, consumes a pending summary, or stages a
 * commit itself. The existing session_before_compact/session_compact pair
 * therefore remains the only correlated apply path.
 */
export function createSettledAutoTrigger(
  options: SettledAutoTriggerOptions = {},
): SettledAutoTrigger {
  const now = options.now ?? Date.now;
  const cooldownMs = Math.max(0, options.cooldownMs ?? SETTLED_TRIGGER_COOLDOWN_MS);
  const active = new Map<string, symbol>();
  const lastCompactionAt = new Map<string, number>();

  const noteCompaction = (sessionId: string): void => {
    if (!isUnresolvedSessionId(sessionId)) lastCompactionAt.set(sessionId, now());
  };

  const clear = (sessionId: string): void => {
    active.delete(sessionId);
    lastCompactionAt.delete(sessionId);
  };

  const request = async (ctx: ExtensionContext, config: CompactConfig): Promise<void> => {
    if (!config.autoTrigger || !["settled", "background"].includes(config.autoTriggerStrategy)) return;

    const sessionId = resolveSessionId(ctx);
    if (isUnresolvedSessionId(sessionId) || active.has(sessionId)) return;

    const usage = ctx.getContextUsage();
    const totalTokens = usage?.tokens;
    if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)
      || totalTokens < MIN_TOKEN_THRESHOLD || !ctx.model) return;

    const contextPercent = safeContextPercent(totalTokens, ctx.model.contextWindow);
    if (contextPercent < config.minContextPercent) return;

    const lastCompaction = lastCompactionAt.get(sessionId);
    if (lastCompaction !== undefined && now() - lastCompaction < cooldownMs) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    const requestToken = Symbol(sessionId);
    active.set(sessionId, requestToken);
    await new Promise<void>(resolve => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (active.get(sessionId) === requestToken) active.delete(sessionId);
        resolve();
      };
      try {
        ctx.compact({
          onComplete: () => {
            if (active.get(sessionId) === requestToken) noteCompaction(sessionId);
            finish();
          },
          onError: error => {
            reportIssue({
              key: "auto.settled-apply",
              message: "Pi could not run the automatic compaction (" + errorDetail(error) + "). Conversation unchanged. Run /smart-compact manually if context is high.",
              error,
            }, ctx);
            finish();
          },
        });
      } catch (error) {
        reportIssue({
          key: "auto.settled-apply",
          message: "Pi could not run the automatic compaction (" + errorDetail(error) + "). Conversation unchanged. Run /smart-compact manually if context is high.",
          error,
        }, ctx);
        finish();
      }
    });
  };

  return { request, noteCompaction, clear };
}
