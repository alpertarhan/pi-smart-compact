# Smart Compact Development Plan Archive

> Historical implementation record for the v7.8.0 delivery wave.
> This file is kept for traceability; the live planning document is [`ROADMAP.md`](./ROADMAP.md).

## Scope of the archived plan

The v7.8.0 work focused on improving compaction quality, performance, observability, and code health across the EESV pipeline.

## Delivered work

### Phase A — Token Estimation v2 + Observability
- [x] Provider-aware token estimation
- [x] LLM call metrics collection
- [x] Result-screen metrics summary
- [x] Structured metrics log at `~/.pi/agent/.cache/compact-metrics.jsonl`

### Phase B — Provider-Aware Strategy
- [x] Provider capability map
- [x] Provider-aware token ratio, concurrency, and output limits
- [x] Tool-support probe caching
- [x] Provider-aware batch concurrency

### Phase C — Parallel Batch Processing
- [x] Wave-based parallel batch execution
- [x] Rate-limit-aware concurrency
- [x] Per-batch fallback handling

### Phase D — Verification v2
- [x] Error/done inconsistency detection
- [x] Hallucinated file-reference detection
- [x] Decision coverage verification
- [x] Constraint coverage checks

### Phase E — Exploration Tools v2
- [x] Dynamic preview sizing
- [x] `get_file_changes`
- [x] `get_error_chain`

### Phase F — Incremental Compaction
- [x] Extraction cache
- [x] Delta extraction and merge
- [x] Pipeline integration for incremental runs

### Phase G — Structured State & Cross-Session Tracking
- [x] `CompactionState` persistence
- [x] Cross-compaction delta computation
- [x] Delta section injection
- [x] Open-loop extraction
- [x] Project fingerprinting
- [x] Damage detection

### Phase H — Code Quality & Audit Fixes
- [x] Options-object API for `runSmartCompact`
- [x] Proper TTL handling via `updatedAt`
- [x] Dead-code removal
- [x] Shared type guards
- [x] Centralized logger
- [x] Cross-platform regex fixes
- [x] Exploration-round handling fixes
- [x] `package.json` types / exports cleanup
- [x] Overlay dead-code cleanup

## Notes

- This file is intentionally archival and does not try to represent the current release state.
- Current package positioning, usage, and architecture summary live in [`README.md`](./README.md).
- Current forward-looking work items live in [`ROADMAP.md`](./ROADMAP.md).
