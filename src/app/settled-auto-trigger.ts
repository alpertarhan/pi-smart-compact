/** Proactive auto-compaction request that delegates all EESV work to Pi's host lifecycle. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactConfig } from "../types.ts";
import { AUTO_TRIGGER_TIMEOUT_CAP_MS, SETTLED_TRIGGER_COOLDOWN_MS } from "../constants.ts";
import { isUnresolvedSessionId, resolveSessionId } from "../infra/session-identity.ts";
import { contextPressure } from "./background-preparation.ts";
import { errorDetail, reportIssue } from "../utils/issues.ts";

export interface SettledAutoTrigger {
  request(ctx: ExtensionContext, config: CompactConfig): Promise<void>;
  noteCompaction(sessionId: string): void;
  clear(sessionId: string): void;
}

export interface SettledAutoTriggerOptions {
  now?: () => number;
  cooldownMs?: number;
  /** Test seam; defaults to the hook budget cap plus the configured run limit. */
  watchdogMs?: number;
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
  const cooldownStartedAt = new Map<string, number>();

  const noteCompaction = (sessionId: string): void => {
    if (!isUnresolvedSessionId(sessionId)) cooldownStartedAt.set(sessionId, now());
  };

  const clear = (sessionId: string): void => {
    active.delete(sessionId);
    cooldownStartedAt.delete(sessionId);
  };

  const request = async (ctx: ExtensionContext, config: CompactConfig): Promise<void> => {
    if (!config.autoTrigger || !["settled", "background"].includes(config.autoTriggerStrategy)) return;

    const sessionId = resolveSessionId(ctx);
    if (isUnresolvedSessionId(sessionId) || active.has(sessionId)) return;

    if (!contextPressure(ctx, config).compaction) return;

    const cooldownStart = cooldownStartedAt.get(sessionId);
    if (cooldownStart !== undefined && now() - cooldownStart < cooldownMs) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    const requestToken = Symbol(sessionId);
    active.set(sessionId, requestToken);
    await new Promise<void>(resolve => {
      let finished = false;
      // Pi normally always answers; a host that never calls back must not pin
      // this session's request slot forever. The budget covers our hook (capped)
      // plus Pi's own summary after a fallback.
      const watchdogMs = options.watchdogMs ?? AUTO_TRIGGER_TIMEOUT_CAP_MS + config.autoTriggerTimeoutMs;
      const watchdog = setTimeout(() => {
        // The callback can legitimately arrive after the watchdog (Pi may
        // still be busy) and the summary can still be applied late. Report
        // the pending state accurately; manual retry is suggested only when
        // the host is actually idle, never while it is still working.
        const hostBusy =
          typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
        reportIssue({
          key: "auto.settled-no-callback",
          message: hostBusy
            ? "Pi is still busy after " +
              Math.round(watchdogMs / 1000) +
              "s; the automatic compaction result may still arrive and be applied late. No action needed; automatic retries wait for the cooldown."
            : "Pi did not report the automatic compaction result within " +
              Math.round(watchdogMs / 1000) +
              "s. Automatic retries wait for the cooldown. Run /smart-compact manually if needed.",
        }, ctx);
        finish();
      }, watchdogMs);
      watchdog.unref?.();
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (active.get(sessionId) === requestToken) {
          active.delete(sessionId);
          // Failed or timed-out work may already have spent provider tokens.
          cooldownStartedAt.set(sessionId, now());
        }
        resolve();
      };
      try {
        ctx.compact({
          onComplete: finish,
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
