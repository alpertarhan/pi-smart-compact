# Smart Compact

[![npm version](https://img.shields.io/npm/v/pi-smart-compact.svg)](https://www.npmjs.com/package/pi-smart-compact)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-alpertarhan%2Fpi--smart--compact-blue)](https://github.com/alpertarhan/pi-smart-compact)

> EESV-powered intelligent context compaction for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

**Smart Compact** compresses long conversation contexts by understanding *what happened* — not by blindly truncating. It deterministically extracts files, errors, decisions, and constraints from your session, then uses LLM-guided exploration and parallel batch synthesis to produce a structured summary that preserves the meaning and state of your work.

The result: a shorter context that the agent can actually work with, without losing critical information.

---

## Why Smart Compact?

Pi's built-in compaction truncates old messages. Smart Compact **understands** them first:

- **Zero-LLM extraction** — files modified/read, errors with retry lifecycle, user decisions, constraints, topic segmentation — all deterministically extracted before any LLM call
- **Hallucination detection** — verifies the summary doesn't invent file paths or misstate error status
- **Decision propagation** — carries decisions across batch boundaries so the LLM never forgets what was decided
- **Redundancy pruning** — collapses duplicate reads, consecutive failures, and low-info messages before compaction, reducing input by 15–30%
- **Cross-session memory** — learns your project's language, framework, and file structure across sessions
- **Damage detection** — monitors post-compaction behavior for regression signals

---

## The EESV Pipeline

```
Extract → Explore → Synthesize → Verify
(0 LLM)  (0–8 LLM) (N+1 LLM)   (0–1 LLM)
```

| Phase | What it does | LLM cost |
|-------|-------------|----------|
| **Extract** | Deterministically mine files, errors, decisions, constraints, topics | **0 calls** |
| **Explore** | LLM investigates conversation with tools to verify boundaries and enrich context. **Skipped for simple sessions.** | 0–8 calls |
| **Synthesize** | Parallel batch summarization with decision propagation, then single-pass assembly | N+1 calls |
| **Verify** | Coverage checks, hallucination detection, deterministic patching (zero LLM), LLM patch only as last resort | 0–1 calls |

### Pre-Processing (before EESV)

```
Pruning: Remove duplicate reads, collapse error chains, strip acknowledgments, truncate long outputs
         ↳ Reduces compaction input by 15–30%
Fingerprint: Load project context (language, framework, known files) from previous sessions
```

### Post-Processing (after EESV)

```
Damage Detection: Monitor agent behavior for regression signals (re-reads, user complaints, re-questions)
                  ↳ Builds a quality feedback dataset over time
```

---

## Installation

```bash
# Option 1: Install via bun (recommended)
bun add pi-smart-compact

# Option 2: Install via npm
npm install pi-smart-compact

# Option 3: Clone directly
cd ~/.pi/agent/extensions
git clone https://github.com/alpertarhan/pi-smart-compact.git
cd pi-smart-compact && bun install
```

Then add to your Pi `settings.json`:

```json
{
  "extensions": ["pi-smart-compact"]
}
```

---

## Usage

### Command

```bash
# Interactive TUI — pick model + profile
/smart-compact

# Direct — specific model + profile
/smart-compact anthropic/claude-sonnet-4 balanced

# Dry run — preview what would be compacted
/smart-compact dry-run

# Verbose — detailed pipeline logging
/smart-compact debug

# Steering note — guide the summary focus
/smart-compact "focus on auth changes"
```

### Tool (agent-callable)

The extension registers a tool the agent can call automatically:

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

### Auto-Trigger

When `autoTrigger` is enabled (default), Smart Compact runs automatically before Pi's built-in compaction kicks in. The `session_before_compact` hook intercepts the event and produces the smart summary instead of blind truncation.

---

## Profiles

| Profile | Summary Budget | Keep Recent | Best For |
|---------|---------------|-------------|----------|
| **light** | 10K tokens | 30K tokens | Debugging sessions, complex multi-file refactors where detail matters |
| **balanced** | 6K tokens | 20K tokens | General development (default) |
| **aggressive** | 3K tokens | 10K tokens | Quick exploration, prototyping, or very large contexts |

---

## Configuration

Add to `~/.pi/agent/settings.json`:

```json
{
  "smartCompact": {
    "profile": "balanced",
    "summaryModel": "anthropic/claude-sonnet-4",
    "segmentationModel": "anthropic/claude-haiku-3",
    "autoTrigger": true,
    "backupEnabled": true,
    "profiles": {
      "balanced": { "summaryBudgetTokens": 6000, "keepRecentTokens": 20000 }
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `profile` | `"light"` \| `"balanced"` \| `"aggressive"` | `"balanced"` | Default compression profile |
| `summaryModel` | `string` \| `null` | `null` | Override model for summarization (e.g. `"anthropic/claude-sonnet-4"`) |
| `segmentationModel` | `string` \| `null` | `null` | Override model for exploration (e.g. `"anthropic/claude-haiku-3"`) |
| `autoTrigger` | `boolean` | `true` | Automatically run on Pi's `session_before_compact` hook |
| `backupEnabled` | `boolean` | `true` | Save conversation backup before compaction |
| `profiles` | `object` | — | Override per-profile token budgets |

---

## Architecture Deep Dive

### Deterministic Extraction (Phase 1)

Zero LLM calls. Extracts purely from message structure:

- **File operations** — tracks read/write/edit/delete with no-op detection (`"applied: 0"`, `"no changes"`)
- **Error lifecycle** — not just "isError" but retry detection (same tool re-called within 6 messages) and resolution tracking
- **Decisions** — explicit (`ask_user` tool calls) and implicit (user choice patterns like "use X instead of Y")
- **Constraints** — regex-based mining with English + Turkish patterns, categorized as requirement/prohibition/preference
- **Topic segmentation** — heuristic boundaries based on file transitions, error density, user "shift" patterns, and token limits

### Adaptive Exploration Gate

Exploration is **skipped** for simple sessions that meet all criteria:
- ≤ 3 topics
- ≤ 1 unresolved error
- ≤ 2 decisions
- ≤ 2 directory groups

This saves 3–8 LLM calls on straightforward sessions.

### Decision Propagation

Each batch receives "Active Decisions from previous segments" — decisions made before the batch's message range. This prevents the common failure mode where Batch 2 doesn't know that Batch 1 decided to use React.

### Immutable Context Framing

The assembly prompt presents deterministic data as **IMMUTABLE CONTEXT** with explicit rules:

> *"These are deterministically verified from the original conversation. They take priority over ANY summary content below."*

This reduces fabrication by making the LLM treat verified data as ground truth.

### Verification & Patching

1. **Verification** — checks file coverage, error coverage, constraint coverage, hallucinated file paths, error-done inconsistencies, decision coverage
2. **Deterministic patch** (score < 85) — injects missing items directly into the relevant markdown sections, zero LLM cost
3. **LLM patch** (score < 75 after deterministic) — last resort, only if deterministic patch was insufficient
4. **Skip** (score ≥ 85) — no patching needed

### Redundancy Pruning

Before compaction, deterministic pruning removes:
- **Duplicate file reads** — keeps only the last read per file
- **Collapsed error chains** — 3+ consecutive same-tool failures → keep first + last only
- **Agent acknowledgments** — "I'll fix that", "Let me check", "Sure" (zero-information messages)
- **Long tool outputs** — truncates to 800 chars (head 400 + tail 400)

### Project Fingerprint

Cross-session learning stored at `~/.pi/agent/.cache/smart-compact/projects/`:

| Field | How it's detected |
|-------|-------------------|
| Language | Most common file extension (.ts → typescript, .rs → rust, etc.) |
| Framework | Config file patterns (next.config → nextjs, vite.config → vite, etc.) |
| Key directories | Most frequently modified directory paths |
| Known files | Last 50 unique files across sessions |
| Session count | Incremented each compaction |

30-day TTL. Loaded before Phase 1 and injected into the synthesis prompt as project context.

### Damage Detection

After compaction, monitors the next 15 messages for regression signals:

| Signal | Severity | Detection |
|--------|----------|-----------|
| Agent re-reads compacted file | Medium | Tool call `read` with path from compacted section |
| User complaint | High | Regex: "I already told you", "you forgot", "nerede kaldı" |
| Re-question | Low | User mentions compacted decision topic |

Logged to `~/.pi/agent/.cache/smart-compact/damage-reports.jsonl` for future analysis.

### Token Estimation

- **Provider-specific ratios** (OpenAI: 4.0, Anthropic: 3.5, MiniMax: 3.8)
- **JSON penalty** (0.85x) — JSON.stringify'd content has denser tokenization
- **Language penalty** (0.9x) — Turkish/CE characters tokenize differently
- **Per-provider EMA calibration** — learns from actual API responses, scoped per provider

### Provider Concurrency

| Provider | Concurrency Limit | Cache Strategy |
|----------|-------------------|----------------|
| OpenAI | 5 | prompt caching |
| Anthropic (zai) | 3 | anthropic caching |
| MiniMax | 2 | anthropic caching |
| Xiaomi | 2 | openai caching |
| Default | 2 | none |

---

## Summary Format

Smart Compact produces structured markdown:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [requirement] Must use TypeScript strict mode
- [preference] Prefer functional components

## Progress
### Done
- [x] Auth module implemented (src/auth.ts)
### In Progress
- [ ] Database migration
### Blocked
- Waiting for API credentials

## Key Decisions
- **Use JWT for auth**: User confirmed over session cookies

## Files Modified
- src/auth.ts
- src/db/migrations/001.sql

## Files Read
- src/config.ts
- package.json

## Next Steps
1. Complete database migration
2. Add integration tests

## Critical Context
- Unresolved error: test failed in auth.ts line 42
- API base URL: https://api.example.com/v2

## Topics Covered
- **Auth implementation** [high]
- **DB schema design** [normal]
- **Config review** [low]
```

---

## Development

```bash
bun install
bun test          # 56 tests across 7 files
bun run typecheck # TypeScript check
```

---

## Contributing

1. Fork the repo
2. Create your branch (`git checkout -b feat/amazing-feature`)
3. Commit (`git commit -am 'Add amazing feature'`)
4. Push (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## License

MIT © [Alper Tarhan](https://github.com/alpertarhan)
