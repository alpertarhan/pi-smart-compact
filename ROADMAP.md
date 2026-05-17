# Roadmap

This document tracks the current forward-looking priorities for `pi-smart-compact`.

## Current priorities

### 1. Summary quality and continuity
- Improve preservation of long-running open loops across repeated compactions
- Tighten completion-status detection for mixed implementation + review sessions
- Reduce edge-case loss around cross-topic decisions and follow-up intent

### 2. Operational robustness
- Keep tool-driven compaction safe inside active agent turns
- Continue hardening verification and deterministic repair paths
- Improve resilience when providers have limited or inconsistent tool support

### 3. Performance and cost
- Reduce unnecessary exploration on simple sessions
- Improve chunk quality for very large branches
- Continue tuning provider-aware batching, concurrency, and cache behavior

### 4. Documentation and package hygiene
- Keep `README.md`, `CHANGELOG.md`, and package metadata in sync
- Minimize drift-prone documentation snapshots
- Preserve a clear separation between user-facing docs and maintainer-oriented implementation notes

## Release hygiene checklist

Before a release:
- sync `package.json` version with runtime constants
- update `CHANGELOG.md`
- rebuild `dist/`
- run `bun test`
- run `bun run build`
- run `bun run typecheck`

## Non-goals for this document

- This is not a historical changelog
- This is not a deep architecture spec
- This is not a complete contributor guide

Those roles belong to `CHANGELOG.md`, `README.md`, and code-level documentation respectively.
