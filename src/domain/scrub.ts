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

/** True for values that reference a secret instead of being one: a dotted
 * identifier chain (`process.env.API_KEY`) or a call expression
 * (`crypto.randomBytes(32).toString()`). Real secrets are opaque
 * single runs; they contain no parentheses and are essentially never dotted. */
function isReferenceValue(value: string): boolean {
  const bare = value.replace(/[;,\]]+$/, "");
  return (
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(bare) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(.*\)(?:\.[A-Za-z_$][\w$]*(?:\(.*\))?)*$/.test(bare)
  );
}

const SECRET_PATTERNS: Pattern[] = [
  {
    kind: "private-key",
    regex:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: "stripe-key", regex: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { kind: "gitlab-token", regex: /\bglpat-[0-9A-Za-z_-]{20,}\b/g },
  { kind: "npm-token", regex: /\bnpm_[0-9A-Za-z]{30,}\b/g },
  { kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "github-token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "api-key", regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    kind: "bearer-token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    replacement: () => "Bearer [REDACTED:bearer-token]",
  },
  {
    kind: "basic-auth",
    regex: /\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g,
    // "Basic authentication ..." is prose, not a credential: only redact
    // when the blob actually decodes to user:password shaped text.
    replacement: (blob, match) => {
      let decoded = "";
      try {
        decoded = Buffer.from(blob, "base64").toString("utf8");
      } catch {
        return match;
      }
      return /^[\x20-\x7e]*:[^\x00-\x1f]*$/.test(decoded)
        ? "Basic [REDACTED:basic-auth]"
        : match;
    },
  },
  {
    kind: "connection-password",
    // Bounded scheme/name runs: unbounded repetitions backtrack quadratically
    // on long hyphen-joined input (60k segments took seconds).
    regex: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi,
    replacement: (prefix, suffix) => prefix + "[REDACTED:password]" + suffix,
  },
  {
    kind: "credential",
    regex:
      /\b((?:[A-Za-z0-9]+[_-]){0,12}(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret(?:[_-]?(?:access)?[_-]?key)?|client[_-]?secret)(?:[_-][A-Za-z0-9]+){0,12})["']?\s*([:=])\s*["']?([^\s"']{16,})["']?/gi,
    replacement: (name, separator, value, match) =>
      isReferenceValue(value)
        ? match
        : name + separator + "[REDACTED:credential]",
  },
  {
    // Short passwords (`DB_PASSWORD=hunter2`) never reach the 16-char rule
    // above. Restrict the shorter bar to assignments and quoted values so
    // type annotations like `password: string` stay readable.
    kind: "credential",
    regex:
      /\b((?:[A-Za-z0-9]+[_-]){0,12}(?:password|passwd)(?:[_-][A-Za-z0-9]+){0,12})["']?\s*([:=])\s*(["']?)([^\s"']{4,15})["']?/gi,
    replacement: (name, separator, quote, value, match) =>
      // Unquoted colon values stay unless they look like a YAML secret
      // (symbol + digit, e.g. `s3cret!`); type names have no digit.
      (separator === ":" && !quote && !(/[^A-Za-z0-9_$]/.test(value) && /\d/.test(value))) ||
      isReferenceValue(value)
        ? match
        : name + separator + "[REDACTED:credential]",
  },
];

/** Standard mod-10 check with a same-digit guard for padded placeholders. */
function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0,
    double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const PII_PATTERNS: Pattern[] = [
  { kind: "email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    kind: "payment-card",
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    // 13-19 digit runs are usually timestamps/IDs, not cards: only Luhn-valid
    // numbers are redacted so epoch timestamps survive PII scrubbing.
    replacement: (candidate) =>
      passesLuhn(candidate) ? "[REDACTED:payment-card]" : candidate,
  },
  { kind: "phone", regex: /(?<![\w.])(?:\+?\d[\d ()-]{8,}\d)(?![\w.])/g },
];

function redact(text: string, patterns: Pattern[]): ScrubResult<string> {
  const counts = new Map<string, number>();
  let value = text;
  for (const pattern of patterns) {
    value = value.replace(pattern.regex, (...args: unknown[]) => {
      const match = String(args[0]);
      let replacement = "[REDACTED:" + pattern.kind + "]";
      if (pattern.replacement) {
        const groups = args.slice(1, -2).map(String);
        // Trailing full-match argument lets replacements without capture groups
        // (payment-card) receive the candidate, and lets "spared" replacements
        // return the exact original text (whitespace intact).
        replacement = pattern.replacement(...groups, match);
      }
      if (replacement === match) return match; // candidate rejected (e.g. Luhn fail): keep, don't count
      counts.set(pattern.kind, (counts.get(pattern.kind) ?? 0) + 1);
      return replacement;
    });
  }
  return {
    value,
    findings: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}

function mergeFindings(
  target: Map<string, number>,
  findings: RedactionFinding[],
): void {
  for (const finding of findings)
    target.set(finding.kind, (target.get(finding.kind) ?? 0) + finding.count);
}

const SECRET_KEY_NAMES: Readonly<Record<string, true>> = {
  api_key: true,
  apikey: true,
  access_token: true,
  auth_token: true,
  authorization: true,
  password: true,
  passwd: true,
  secret: true,
  secret_key: true,
  secret_access_key: true,
  client_secret: true,
  private_key: true,
  database_url: true,
  connection_string: true,
  token: true,
  refresh_token: true,
  session_token: true,
  credential: true,
  credentials: true,
  cookie: true,
  set_cookie: true,
  otp: true,
  one_time_password: true,
  passcode: true,
};

function normalizeObjectKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSecretBearingKey(key: string): boolean {
  const normalized = normalizeObjectKey(key);
  if (SECRET_KEY_NAMES[normalized]) return true;
  return /(?:^|_)(?:api_key|access_token|auth_token|password|passwd|secret_access_key|client_secret|private_key|refresh_token|session_token|one_time_password|passcode)(?:_|$)/.test(
    normalized,
  );
}

/** Run-scoped scrubber used at LLM, cache, backup and persistence boundaries. */
export class SecretScrubber {
  private total = 0;

  constructor(
    private readonly secretsEnabled = true,
    private readonly piiEnabled = false,
  ) {}

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
    const recordCredential = (): void => {
      findings.set("credential", (findings.get("credential") ?? 0) + 1);
      this.total++;
    };
    const visit = <Value>(value: Value): Value => {
      if (typeof value === "string") {
        const result = this.scrubText(value);
        mergeFindings(findings, result.findings);
        return result.value as Value;
      }
      if (value == null || typeof value !== "object") return value;
      const cached = seen.get(value);
      if (cached !== undefined) return cached as Value;
      if (Array.isArray(value)) {
        const output: unknown[] = [];
        seen.set(value, output);
        for (const item of value) output.push(visit(item));
        return output as Value;
      }
      const output: Record<string, unknown> = {};
      seen.set(value, output);
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
        // Secret values are long opaque strings. Numbers, booleans and nested
        // objects are configuration shapes (map pins, parser options) —
        // redacting those corrupts ground truth and backups irreversibly.
        const carriesSecret = typeof item === "string" && item.length >= 8;
        if (this.secretsEnabled && isSecretBearingKey(key) && carriesSecret) {
          output[key] = "[REDACTED:credential]";
          recordCredential();
        } else {
          output[key] = visit(item);
        }
      }
      return output as Value;
    };
    const value = visit(input);
    return {
      value,
      findings: [...findings].map(([kind, count]) => ({ kind, count })),
    };
  }

  count(): number {
    return this.total;
  }
}
