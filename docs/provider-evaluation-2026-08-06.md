# Provider Evaluation Baseline — 2026-08-06

This is a local, advisory snapshot for Smart Compact's provider-routing work. It
does **not** change the selected Pi model or any route.

## Method

Five available models received the same three bounded coding-continuity
scenarios (`implementation`, `debugging`, `continuity`). Output was capped at
1,500 tokens and checked with Smart Compact's deterministic verifier. Calls
were sequential to avoid a provider burst.

```bash
bun run provider-eval:live --live \
  --models=openai-codex/gpt-5.3-codex-spark,zai-anthropic/glm-5.2,minimax-m3/MiniMax-M3,moonshot-anthropic/kimi-k3,claudin/claudinio
```

## Results

| Model | Scenario | Verify | Latency | Input | Output | Status |
|---|---|---:|---:|---:|---:|---|
| openai-codex/gpt-5.3-codex-spark | implementation | 95 | 4,685ms | 157 | 548 | ok |
| openai-codex/gpt-5.3-codex-spark | debugging | 90 | 8,556ms | 160 | 532 | ok |
| openai-codex/gpt-5.3-codex-spark | continuity | 100 | 2,564ms | 165 | 392 | ok |
| zai-anthropic/glm-5.2 | implementation | 100 | 7,622ms | 160 | 504 | ok |
| zai-anthropic/glm-5.2 | debugging | 100 | 8,915ms | 165 | 574 | ok |
| zai-anthropic/glm-5.2 | continuity | 100 | 10,331ms | 170 | 720 | ok |
| minimax-m3/MiniMax-M3 | implementation | 95 | 13,142ms | 316 | 862 | ok |
| minimax-m3/MiniMax-M3 | debugging | 100 | 6,268ms | 191 | 520 | ok |
| minimax-m3/MiniMax-M3 | continuity | 100 | 4,731ms | 197 | 547 | ok |
| moonshot-anthropic/kimi-k3 | all three | 0 | 221–347ms | 0 | 0 | 401 invalid authentication |
| claudin/claudinio | implementation | 100 | 45,798ms | 11,492 | 4,669 | ok |
| claudin/claudinio | debugging | 100 | 52,553ms | 104 | 5,029 | ok |
| claudin/claudinio | continuity | 0 | 60,002ms | 0 | 0 | timeout |

## Interpretation

| Model | Mean verify | Mean successful latency | Reliability |
|---|---:|---:|---:|
| openai-codex/gpt-5.3-codex-spark | 95.0 | 5,268ms | 3/3 |
| zai-anthropic/glm-5.2 | 100.0 | 8,956ms | 3/3 |
| minimax-m3/MiniMax-M3 | 98.3 | 8,047ms | 3/3 |
| claudin/claudinio | 66.7 including timeout | 49,176ms | 2/3 |
| moonshot-anthropic/kimi-k3 | 0 | n/a | 0/3 |

The historical 278-run operational matrix also favored
`openai-codex/gpt-5.3-codex-spark` for latency in every sufficiently sampled
context/tool-density bucket. Historical verifier scores are intentionally not
used because their semantics predate metrics schema v2.

**Decision:** keep all routes on the selected/configured model. Three samples
per model are below the five-sample recommendation floor. GLM 5.2 and MiniMax
M3 are candidates for further schema-v2 evaluation, not automatic routing.
Fix Moonshot authentication before retesting; do not route to Claudin while its
latency/timeout profile remains this weak.

## Limits

- One run per model/scenario; no variance or outage coverage.
- Short controlled prompts, not full production compaction windows.
- Verification measures continuity/structure, not prose preference or price.
- Provider token accounting differs, so raw token columns are not cross-provider cost estimates.
- Endpoint health and model revisions can change these results.
