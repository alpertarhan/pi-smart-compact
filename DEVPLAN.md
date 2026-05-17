# Smart Compact v7.8.0 Development Plan — TAMAMLANDI ✅

> **Not:** Bu döküman v7.8.0 geliştirme planıdır. Yeni özellikler ve iyileştirmeler için ROADMAP.md'e bakınız.

## Hedef
Context window'u hem LLM server tarafında (cache hits, token efficiency) hem 
local makinemizde (compaction hızı, memory) optimum kullanmak.

## Phases — Implementation Status

### ✅ Phase A: Token Estimation v2 + Observability
- [x] A1: Token estimation — provider bazlı ratio (3.3-4.0) + EMA calibration factor
- [x] A2: LLM call metrics collector — `trackedComplete()` wrapper ile her çağrıdan input/output/cache/latency
- [x] A3: Result screen'e metrics line (LLM calls, input tokens, cache hit %, avg latency)
- [x] A4: Structured log file (`~/.pi/agent/.cache/compact-metrics.jsonl`)

### ✅ Phase B: Provider-Aware Strategy
- [x] B1: ProviderCapabilities map — 4 provider (Zhipu/MiniMax/Xiaomi/OpenAI)
- [x] B2: Provider-aware tokenRatio + concurrency + maxOutput
- [x] B3: Tool probe caching — known providers skip probe
- [x] B4: Provider-aware concurrency in batch processing

### ✅ Phase C: Parallel Batch Processing
- [x] C1: Wave-based parallel batch processing (Promise.all per wave)
- [x] C2: Rate-limit aware concurrency (PROVIDER_MAP.concurrencyLimit)
- [x] C3: Per-batch error handling (failed batch → fallback summary)

### ✅ Phase D: Verification v2
- [x] D1: Error-Done inconsistency detection
- [x] D2: Hallucination detection (nonexistent file references)
- [x] D3: Decision coverage verification
- [x] D4: Constraint inclusion check

### ✅ Phase E: Exploration Tools v2
- [x] E1: Dynamic preview sizing via token budget
- [x] E2: get_file_changes tool (diff summary for modified files)
- [x] E3: get_error_chain tool (error-surrounding messages)

### ✅ Phase F: Incremental Compaction
- [x] F1: Extraction cache — JSON per session (1hr TTL)
- [x] F2: Delta extraction — only new messages + merge
- [x] F3: Pipeline integration with incremental path

### ✅ Phase G: Structured State & Cross-Session Tracking (v7.5+)
- [x] G1: CompactionState interface + save/load (cross-compaction delta)
- [x] G2: computeDelta — decisions, errors, files, open loops diff
- [x] G3: Delta section injection into summary
- [x] G4: Open Loops extraction (bugfix, follow-up, blocked, retry)
- [x] G5: Project fingerprinting (language, framework, key dirs)
- [x] G6: Damage detection (post-compaction regression signals)

### ✅ Phase H: Code Quality & Audit Fixes (v7.8.0)
- [x] H1: Options object pattern for runSmartCompact
- [x] H2: CompactionState.updatedAt + proper TTL logic
- [x] H3: Dead code removal (message-blocks.ts, duplicate interfaces/functions)
- [x] H4: Type guards extracted to utils/type-guards.ts
- [x] H5: Centralized logger (utils/logger.ts)
- [x] H6: Cross-platform regex in patchDeterministic
- [x] H7: directExploration rounds: 1 fix
- [x] H8: package.json types/exports fields
- [x] H9: Overlay dead code (probeToolSupport) removed
