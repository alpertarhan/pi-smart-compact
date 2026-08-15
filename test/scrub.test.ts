import { describe, expect, it } from "bun:test";
import { SecretScrubber } from "../src/domain/scrub.ts";
import { createServices } from "../src/infra/services.ts";
import { trackedComplete } from "../src/utils/cache.ts";

describe("SecretScrubber", () => {
  it("redacts high-confidence credentials and is idempotent", () => {
    const source = [
      "AWS=AKIAABCDEFGHIJKLMNOP",
      "token=abcdefghijklmnopqrstuvwxyz123456",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "jwt eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop",
    ].join("\n");
    const scrubber = new SecretScrubber(true, false);
    const once = scrubber.scrubText(source).value;
    const twice = scrubber.scrubText(once).value;
    expect(once).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(once).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(twice).toBe(once);
  });

  it("does not redact benign short lookalikes", () => {
    const result = new SecretScrubber(true, false).scrubText(
      "sk-example and token=userToken and version 7.20.0",
    ).value;
    expect(result).toBe("sk-example and token=userToken and version 7.20.0");
  });

  it("redacts common provider secrets and credential-bearing connection URIs", () => {
    const google = "AIza" + "A".repeat(35);
    const source = [
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "STRIPE_SECRET_KEY=sk_live_1234567890abcdefghijk",
      "GOOGLE_API_KEY=" + google,
      "DATABASE_URL=postgres://admin:SuperSecretPassword123@db.example/app",
    ].join("\n");
    const value = new SecretScrubber(true, false).scrubText(source).value;
    expect(value).not.toContain("wJalrXUtnFEMI");
    expect(value).not.toContain("sk_live_");
    expect(value).not.toContain(google);
    expect(value).not.toContain("SuperSecretPassword123");
    expect(value).toContain(
      "postgres://admin:[REDACTED:password]@db.example/app",
    );
  });

  it("uses object keys as secret evidence without redacting token counters", () => {
    const source = {
      AWS_SECRET_ACCESS_KEY: "short-but-secret",
      clientSecret: "another-secret",
      maxTokens: 8192,
      tokenRatioEstimate: 3.8,
    };
    const value = new SecretScrubber(true, false).scrubValue(source).value;
    expect(value.AWS_SECRET_ACCESS_KEY).toBe("[REDACTED:credential]");
    expect(value.clientSecret).toBe("[REDACTED:credential]");
    expect(value.maxTokens).toBe(8192);
    expect(value.tokenRatioEstimate).toBe(3.8);
  });

  it("keeps PII disabled by default and supports opt-in", () => {
    const text = "Contact dev@example.com";
    expect(new SecretScrubber(true, false).scrubText(text).value).toContain(
      "dev@example.com",
    );
    expect(new SecretScrubber(true, true).scrubText(text).value).not.toContain(
      "dev@example.com",
    );
  });

  it("scrubs nested tool-call arguments without mutating the source", () => {
    const source = {
      messages: [
        {
          content: [
            {
              type: "toolCall",
              arguments: { token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" },
            },
          ],
        },
      ],
    };
    const result = new SecretScrubber().scrubValue(source).value;
    expect(result.messages[0].content[0].arguments.token).toContain("REDACTED");
    expect(source.messages[0].content[0].arguments.token).toContain("ghp_");
  });

  it("does not redact non-string or short values under secret-bearing keys", () => {
    const result = new SecretScrubber(true, false).scrubValue({
      pin: { x: 1, y: 2 },
      token: { parser: true },
      password: 12345678,
      access_token: "short",
    });
    expect(result.value).toEqual({
      pin: { x: 1, y: 2 },
      token: { parser: true },
      password: 12345678,
      access_token: "short",
    });
    expect(result.findings.length).toBe(0);
  });

  it("still redacts long string values under secret-bearing keys", () => {
    const result = new SecretScrubber(true, false).scrubValue({
      access_token: "abcdefghijklmnopqrstuvwxyz123456",
    });
    expect((result.value as Record<string, string>).access_token).toBe(
      "[REDACTED:credential]",
    );
  });

  it("spares dotted env references from the credential regex", () => {
    const kept = new SecretScrubber(true, false).scrubText(
      "token: process.env.API_KEY",
    ).value;
    expect(kept).toBe("token: process.env.API_KEY");
    const redacted = new SecretScrubber(true, false).scrubText(
      "access_token: abcdefghijklmnopqrstuvwxyz123456",
    ).value;
    expect(redacted).toContain("[REDACTED:credential]");
  });

  it("payment-card counts only Luhn-valid numbers", () => {
    const timestamp = new SecretScrubber(false, true).scrubText(
      "at 1739570400000 ms",
    );
    expect(
      timestamp.findings.some((finding) => finding.kind === "payment-card"),
    ).toBe(false);
    const card = new SecretScrubber(false, true).scrubText(
      "card 4111111111111119 x, 4111111111111111 y",
    );
    expect(
      card.findings.find((finding) => finding.kind === "payment-card")?.count,
    ).toBe(1);
  });
});

describe("trackedComplete secret boundary", () => {
  it("sends only scrubbed request content to the provider", async () => {
    let observed = "";
    const services = createServices({
      scrubber: new SecretScrubber(true, false),
      llm: {
        complete: async (_model, context) => {
          observed = JSON.stringify(context);
          return {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            usage: { input: 1, output: 1 },
            stopReason: "stop",
          } as any;
        },
      },
    });
    await trackedComplete(
      "single-pass",
      { id: "test", provider: "openai" } as any,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "token=abcdefghijklmnopqrstuvwxyz123456" },
            ],
          },
        ],
      } as any,
      {},
      services,
    );
    expect(observed).toContain("REDACTED");
    expect(observed).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});
