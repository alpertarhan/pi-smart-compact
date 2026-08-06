interface Entry { text: string; createdAt: number }

export interface NativeContinuityBridge {
  stage(sessionId: string, text: string): void;
  take(sessionId: string): string | null;
  clear(sessionId?: string): void;
  size(): number;
}

export function createNativeContinuityBridge(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): NativeContinuityBridge {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const maxEntries = Math.max(1, opts.maxEntries ?? 16);
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  return {
    stage(sessionId, text) {
      if (!text.trim()) return;
      entries.delete(sessionId);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (!oldest) break;
        entries.delete(oldest);
      }
      entries.set(sessionId, { text, createdAt: now() });
    },
    take(sessionId) {
      const entry = entries.get(sessionId);
      entries.delete(sessionId);
      return entry && now() - entry.createdAt <= ttlMs ? entry.text : null;
    },
    clear(sessionId) { if (sessionId) entries.delete(sessionId); else entries.clear(); },
    size() { return entries.size; },
  };
}
