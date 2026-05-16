# Smart Compact

> EESV-powered smart compaction extension for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

[![Version](https://img.shields.io/badge/version-7.3.2-blue)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## What is it?

**Smart Compact** compresses long conversation contexts by understanding *what happened* instead of blindly truncating. It uses the **EESV architecture**:

| Phase | What it does | LLM calls |
|-------|-------------|-----------|
| **Extract** | Deterministically pull files, errors, decisions, constraints, topics | 0 |
| **Explore** | Use LLM tools to verify boundaries and enrich context (skipped for simple sessions) | 0–8 |
| **Synthesize** | Parallel batch summarization + assembly | N + 1 |
| **Verify** | Check coverage, detect hallucinations, patch gaps | 0–1 |

**Result:** Shorter context that preserves the *meaning* and *state* of your session.

---

## Features

- 🔍 **Deterministic extraction** — zero-LLM-call file/error/decision mining
- 🧭 **Tool-calling exploration** — targeted investigation with `get_message_range`, `search_conversation`, `get_error_chain`
- ⚡ **Parallel batch synthesis** — provider-aware concurrency (2–5 in flight)
- ✅ **Automated verification** — coverage checks, hallucination detection, gap patching
- 📊 **Live metrics** — token savings, cache hit rate, latency per phase
- 🎛️ **Profiles** — `light` / `balanced` / `aggressive` compression
- 💾 **Backup & incremental cache** — safe rollback, delta re-compaction
- 🧠 **Adaptive exploration** — skips Phase 2 for simple sessions, saving 3–8 LLM calls
- 🔧 **Provider-aware token estimation** — language and JSON-aware with per-provider calibration

---

## Install

```bash
# Inside your Pi agent extensions directory
cd ~/.pi/agent/extensions
git clone https://github.com/YOUR_USERNAME/pi-smart-compact.git
cd pi-smart-compact
bun install
```

Add to your Pi `settings.json`:

```json
{
  "extensions": ["pi-smart-compact"]
}
```

Or via `package.json` (already configured):

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

---

## Usage

```bash
# TUI — pick model + profile
/smart-compact

# Direct — specific model + profile
/smart-compact anthropic/claude-sonnet-4 balanced

# Dry run — preview only
/smart-compact dry-run

# Verbose — detailed logging
/smart-compact debug

# Add a steering note
/smart-compact "focus on auth changes"
```

### Tool Usage

The extension also registers a tool named `smart_compact`:

```json
{
  "name": "smart_compact",
  "parameters": {
    "profile": "balanced",
    "verbose": false,
    "dry_run": false
  }
}
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Conversation (too long)                     │
└──────────────┬──────────────────────────────┘
               │
  ┌────────────▼────────────┐
  │  Phase 1: EXTRACT       │  ← deterministic (0 LLM calls)
  │  • files modified/read  │
  │  • errors + retries     │
  │  • decisions            │
  │  • constraints          │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Phase 2: EXPLORE       │  ← LLM with tools (0–8 rounds)
  │  • verify topic bounds  │  ← skipped for simple sessions
  │  • find cross-references│
  │  • assess status        │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Phase 3: SYNTHESIZE    │  ← parallel batch summarize
  │  • chunk messages       │
  │  • summarize batches    │
  │  • assemble final       │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Phase 4: VERIFY        │  ← deterministic checks
  │  • coverage gaps?       │
  │  • hallucinated files?  │
  │  • patch if needed      │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Compact context applied│
  └─────────────────────────┘
```

---

## Profiles

| Profile | Summary Budget | Keep Recent | Best For |
|---------|---------------|-------------|----------|
| **light** | 10K tokens | 30K tokens | Debugging, complex multi-file refactors |
| **balanced** | 6K tokens | 20K tokens | General development (default) |
| **aggressive** | 3K tokens | 10K tokens | Quick exploration, prototyping |

---

## Configuration

Create `~/.pi/agent/settings.json`:

```json
{
  "smartCompact": {
    "profile": "balanced",
    "summaryModel": "anthropic/claude-sonnet-4",
    "segmentationModel": "anthropic/claude-haiku-3",
    "autoTrigger": true,
    "backupEnabled": true,
    "profiles": {
      "light": { "summaryBudgetTokens": 10000, "keepRecentTokens": 30000 }
    }
  }
}
```

---

## Development

```bash
bun install
bun test         # runs test suite
```

---

## Contributing

1. Fork it
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -am 'Add amazing feature'`)
4. Push (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## License

MIT © [Alper](https://github.com/alper)
