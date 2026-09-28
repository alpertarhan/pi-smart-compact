# Review findings

Audit reports produced by external models and agent harnesses against this
checkout. Each report is the reviewer's own analysis of a specific revision
range: it is advisory, not a maintenance contract, a release gate or a claim
about published behavior. Treat dated reports like the historical evidence in
[`docs/`](../README.md): they can describe a candidate that has since changed.

One folder per reviewer, named `<model>-<harness>` in lowercase; one dated
report per review inside it.

| Reviewer | Report | Scope |
| --- | --- | --- |
| `deepseek-v4.1-flash-opencode` | [Recent-changes review, 2026-09-28](./deepseek-v4.1-flash-opencode/2026-09-28-recent-changes-review.md) | Commits #75–#79 (`9.8.0-canary.7` wave) |
| `glm-5.3-pi` | [Recent-changes ponytail review, 2026-09-28](./glm-5.3-pi/2026-09-28-recent-changes-ponytail-review.md) | Commits #75–#79 (`9.8.0-canary.7` wave) |
| `claude-opus-5-5-pi` | [Recent-changes review, 2026-09-28](./claude-opus-5-5-pi/2026-09-28-recent-changes-review.md) | Commits #76–#79 line-by-line; #75 packaging/bloat only |
| `muse-spark-1.3-contributor-pi` | [Recent-changes ponytail review, 2026-09-28](./muse-spark-1.3-contributor-pi/2026-09-28-recent-changes-ponytail-review.md) | Commits #75–#79 (`9.8.0-canary.7` wave) |

Conventions for review reports:

- Every finding cites `path:line` and states how it was verified: reproduced
  behavior, direct code reading, or observation (for example an intermittent
  test failure).
- Severity reflects user-visible impact and data/behavior risk, not effort.
- Suggested fixes are directions, not reviewed patches.
- The report states what was *not* reviewed, so absence of a finding is not
  mistaken for evidence of correctness.
