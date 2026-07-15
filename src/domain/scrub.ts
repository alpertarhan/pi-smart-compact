export interface RedactionFinding {
  kind: string;
  count: number;
}

export interface ScrubResult<T = string> {
  value: T;
  findings: RedactionFinding[];
}

interface Pattern {
  kind: string;
  regex: RegExp;
  replacement?: (...groups: string[]) => string;
}

const SECRET_PATTERNS: Pattern[] = [
  { kind: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: "api-key", regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/gi, replacement: () => "Bearer [REDACTED:bearer-token]" },
  {
    kind: "credential",
    regex: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*([:=])\s*["']?([A-Za-z0-9._~+\/-]{16,})["']?/gi,
    replacement: (name, separator) => name + separator + "[REDACTED:credential]",
  },
];

const PII_PATTERNS: Pattern[] = [
  { kind: "email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: "payment-card", regex: /\b(?:\d[ -]*?){13,19}\b/g },
  { kind: "phone", regex: /(?<![\w.])(?:\+?\d[\d ()-]{8,}\d)(?![\w.])/g },
];

function redact(text: string, patterns: Pattern[]): ScrubResult<string> {
  const counts = new Map<string, number>();
  let value = text;
  for (const pattern of patterns) {
    value = value.replace(pattern.regex, (...args: unknown[]) => {
      counts.set(pattern.kind, (counts.get(pattern.kind) ?? 0) + 1);
      if (pattern.replacement) {
        const groups = args.slice(1, -2).map(String);
        return pattern.replacement(...groups);
      }
      return "[REDACTED:" + pattern.kind + "]";
    });
  }
  return { value, findings: [...counts].map(([kind, count]) => ({ kind, count })) };
}

function mergeFindings(target: Map<string, number>, findings: RedactionFinding[]): void {
  for (const finding of findings) target.set(finding.kind, (target.get(finding.kind) ?? 0) + finding.count);
}

/** Run-scoped scrubber used at LLM, cache, backup and persistence boundaries. */
export class SecretScrubber {
  private total = 0;

  constructor(private readonly secretsEnabled = true, private readonly piiEnabled = false) {}

  scrubText(text: string): ScrubResult<string> {
    let value = text;
    const findings = new Map<string, number>();
    if (this.secretsEnabled) {
      const result = redact(value, SECRET_PATTERNS);
      value = result.value;
      mergeFindings(findings, result.findings);
    }
    if (this.piiEnabled) {
      const result = redact(value, PII_PATTERNS);
      value = result.value;
      mergeFindings(findings, result.findings);
    }
    const merged = [...findings].map(([kind, count]) => ({ kind, count }));
    this.total += merged.reduce((sum, finding) => sum + finding.count, 0);
    return { value, findings: merged };
  }

  scrubValue<T>(input: T): ScrubResult<T> {
    const findings = new Map<string, number>();
    const seen = new WeakMap<object, unknown>();
    const visit = (value: unknown): unknown => {
      if (typeof value === "string") {
        const result = this.scrubText(value);
        mergeFindings(findings, result.findings);
        return result.value;
      }
      if (value == null || typeof value !== "object") return value;
      const cached = seen.get(value);
      if (cached !== undefined) return cached;
      if (Array.isArray(value)) {
        const output: unknown[] = [];
        seen.set(value, output);
        for (const item of value) output.push(visit(item));
        return output;
      }
      const output: Record<string, unknown> = {};
      seen.set(value, output);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = visit(item);
      return output;
    };
    const value = visit(input) as T;
    return { value, findings: [...findings].map(([kind, count]) => ({ kind, count })) };
  }

  count(): number { return this.total; }
}
