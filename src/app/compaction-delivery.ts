import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSmartCompact, type SmartCompactOptions, type CompactOutcome } from "./run-smart-compact.ts";
import { notifyUser, reportIssue } from "../utils/issues.ts";

/** Optional synchronous protocol; participating senders retain their normal delivery semantics. */
interface DeliveryRequest {
  version: 1;
  sessionId: string;
  deliver: () => void;
  deferred: boolean;
}

interface Gate {
  sessionId: string;
  ctx: ExtensionContext;
  scopes: Set<symbol>;
  queue: DeliveryRequest[];
  pause?: "cancelled" | "delivery-error";
  draining: boolean;
  resumeOnTurnStart?: boolean;
  announced: boolean;
  timer?: ReturnType<typeof setTimeout>;
  releaseNative?: () => void;
}

const STATUS = "smart-compact-inbox";

/** Hold external messages, not the agent loop or speculative background preparation. */
export function registerCompactionDelivery(pi: ExtensionAPI): {
  runManual: (options: SmartCompactOptions) => Promise<CompactOutcome>;
  guard: (ctx: ExtensionContext) => ExtensionContext;
  /** Return an idle-checked recovery callback for the automatic request's watchdog. */
  compact: (ctx: ExtensionContext, options?: CompactOptions) => () => void;
} {
  if (typeof pi.events?.on !== "function") return {
    runManual: runSmartCompact, guard: ctx => ctx,
    compact: (ctx, options) => { ctx.compact(options); return () => {}; },
  };
  let current: Gate | undefined;

  const clear = () => {
    const gate = current;
    current = undefined;
    if (gate?.timer) clearTimeout(gate.timer);
    try { if (gate?.ctx.hasUI) gate.ctx.ui.setStatus(STATUS, undefined); }
    catch { /* Disposed UI must not retain the delivery state. */ }
  };
  const matches = (gate: Gate, ctx = gate.ctx): boolean => {
    if (current !== gate) return false;
    try { return ctx.sessionManager.getSessionId() === gate.sessionId; }
    catch { clear(); return false; } // Pi can invalidate a captured ctx before shutdown handlers run.
  };
  const showStatus = (gate: Gate) => {
    if (!matches(gate) || !gate.ctx.hasUI) return;
    const phase = gate.scopes.size ? "compacting" : gate.pause === "cancelled"
      ? "cancelled; send a message to resume" : gate.pause === "delivery-error"
        ? "delivery failed; retry on next run" : "resuming";
    try {
      gate.ctx.ui.setStatus(STATUS, gate.queue.length
        ? `${gate.queue.length} notification${gate.queue.length === 1 ? "" : "s"} queued · ${phase}`
        : undefined);
    } catch { /* A rendering failure must not prevent delivery. */ }
  };
  const pauseCancelled = (gate: Gate) => {
    if (!matches(gate)) return;
    gate.pause = "cancelled";
    showStatus(gate);
    if (gate.queue.length && gate.ctx.hasUI) notifyUser(gate.ctx,
      `Compaction cancelled; ${gate.queue.length} notifications are waiting. Send a message to resume, or retry compaction.`, "info");
  };

  function drain(gate: Gate): void {
    if (!matches(gate) || gate.scopes.size || gate.pause || gate.draining) return;
    clearTimeout(gate.timer);
    gate.timer = undefined;
    gate.draining = true;
    const failed: DeliveryRequest[] = [];
    try {
      while (gate.queue.length && matches(gate) && !gate.scopes.size && !gate.pause) {
        const request = gate.queue.shift();
        if (!request) break;
        try { request.deliver(); }
        catch (error) {
          failed.push(request);
          reportIssue({ key: "delivery.failed", message: "A deferred notification could not be delivered. It remains queued for the next run; other notifications can continue.", error }, gate.ctx);
        }
      }
    } finally {
      gate.draining = false;
      if (matches(gate)) {
        // Failed callbacks are retried later, never repeatedly in this drain or ahead of healthy mail.
        gate.queue.unshift(...failed);
        if (failed.length && !gate.scopes.size && !gate.pause) gate.pause = "delivery-error";
        if (!gate.scopes.size && !gate.queue.length && !gate.pause) clear();
        else showStatus(gate);
      }
    }
  }

  function checkIdle(gate: Gate): void {
    if (!matches(gate) || gate.scopes.size || gate.pause || gate.timer) return;
    // session_compact runs before Pi clears its compacting flag, including after other async handlers.
    gate.timer = setTimeout(() => {
      gate.timer = undefined;
      if (!matches(gate) || gate.scopes.size || gate.pause) return;
      if (gate.ctx.isIdle()) drain(gate);
      else checkIdle(gate);
    }, 25);
    gate.timer.unref();
  }

  function acquire(ctx: ExtensionContext): { gate: Gate; release: () => void } {
    const sessionId = ctx.sessionManager.getSessionId();
    if (current && current.sessionId !== sessionId) clear();
    const gate = current ??= { sessionId, ctx, scopes: new Set(), queue: [], draining: false, announced: false };
    const token = Symbol();
    gate.scopes.add(token);
    clearTimeout(gate.timer);
    gate.timer = undefined;
    showStatus(gate);
    return { gate, release: () => {
      if (!matches(gate) || !gate.scopes.delete(token)) return;
      showStatus(gate);
      checkIdle(gate);
    } };
  }

  const unsubscribe = pi.events.on("smart-compact:defer-delivery", (data: unknown) => {
    const request = data as Partial<DeliveryRequest> | null;
    if (!current || !request || request.version !== 1 || request.deferred !== false
      || request.sessionId !== current.sessionId || typeof request.deliver !== "function"
      || !matches(current)) return;
    // A failed producer must not capture newly arriving healthy notifications after compaction.
    if (!current.scopes.size && current.pause === "delivery-error") return;
    current.queue.push(request as DeliveryRequest);
    request.deferred = true;
    showStatus(current);
    if (!current.announced) {
      current.announced = true;
      if (current.ctx.hasUI) notifyUser(current.ctx,
        "Notifications are queued in memory until compaction finishes. A reload or exit can lose process notifications.", "info");
    }
  });

  pi.on("session_before_compact", (_event, ctx) => {
    const { gate, release } = acquire(ctx);
    gate.releaseNative = release;
  });
  const finishNative = (ctx: ExtensionContext, aborted = false) => {
    if (!current || !matches(current, ctx)) return;
    if (aborted) pauseCancelled(current);
    else current.pause = undefined;
    const release = current.releaseNative;
    current.releaseNative = undefined;
    release?.();
  };
  pi.on("session_compact", (_event, ctx) => finishNative(ctx));
  pi.on("session_compact_failed", (event, ctx) => finishNative(ctx, event.aborted));
  const naturalRun = (ctx: ExtensionContext) => {
    if (!current || !matches(current, ctx) || current.draining) return;
    current.pause = undefined;
    current.resumeOnTurnStart = false;
    drain(current);
  };
  pi.on("before_agent_start", (_event, ctx) => {
    if (current && matches(current, ctx) && !current.draining && ctx.isIdle()) {
      // Older Pi reserves the run after this hook; waking a sender here starts a second prompt.
      current.resumeOnTurnStart = true;
      return;
    }
    naturalRun(ctx);
  });
  pi.on("turn_start", (_event, ctx) => {
    // before_agent_start already tried failed callbacks; do not retry them on every tool-loop turn.
    if (current?.pause !== "delivery-error" || current?.resumeOnTurnStart) naturalRun(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (current && matches(current, ctx)) checkIdle(current);
  });
  pi.on("session_start", clear);
  pi.on("session_shutdown", () => { clear(); unsubscribe(); });

  const compact = (ctx: ExtensionContext, callbacks?: CompactOptions): (() => void) => {
    // Cover the host's initial abort/idle wait before session_before_compact is emitted.
    const { gate, release } = acquire(ctx);
    let completed = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { completed = true; clearTimeout(recoveryTimer); release(); };
    const recoverWhenIdle = () => {
      if (completed || !matches(gate)) return;
      clearTimeout(recoveryTimer);
      if (ctx.isIdle()) finish();
      else {
        recoveryTimer = setTimeout(recoverWhenIdle, 25);
        recoveryTimer.unref();
      }
    };
    try {
      ctx.compact({ ...callbacks,
        onComplete: result => {
          try { callbacks?.onComplete?.(result); }
          finally { finish(); }
        },
        onError: error => {
          try { callbacks?.onError?.(error); }
          finally { finish(); }
        },
      });
    } catch (error) {
      finish();
      throw error;
    }
    return recoverWhenIdle;
  };
  const guard = (ctx: ExtensionContext): ExtensionContext => {
    const guarded: ExtensionContext = Object.create(ctx);
    guarded.compact = callbacks => { compact(ctx, callbacks); };
    return guarded;
  };

  return {
    compact,
    guard,
    async runManual(options) {
      const { gate, release } = acquire(options.ctx);
      try {
        const outcome = await runSmartCompact({ ...options, ctx: guard(options.ctx) });
        if (outcome.kind === "cancelled" && outcome.source !== "timeout") pauseCancelled(gate);
        return outcome;
      } finally {
        release();
      }
    },
  };
}
