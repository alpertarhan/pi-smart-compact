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
    const result = new SecretScrubber(true, false).scrubText("sk-example and token=userToken and version 7.20.0").value;
    expect(result).toBe("sk-example and token=userToken and version 7.20.0");
  });

  it("keeps PII disabled by default and supports opt-in", () => {
    const text = "Contact dev@example.com";
    expect(new SecretScrubber(true, false).scrubText(text).value).toContain("dev@example.com");
    expect(new SecretScrubber(true, true).scrubText(text).value).not.toContain("dev@example.com");
  });

  it("scrubs nested tool-call arguments without mutating the source", () => {
    const source = { messages: [{ content: [{ type: "toolCall", arguments: { token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" } }] }] };
    const result = new SecretScrubber().scrubValue(source).value;
    expect(result.messages[0].content[0].arguments.token).toContain("REDACTED");
    expect(source.messages[0].content[0].arguments.token).toContain("ghp_");
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
          return { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1 }, stopReason: "stop" } as any;
        },
      },
    });
    await trackedComplete(
      "single-pass",
      { id: "test", provider: "openai" } as any,
      { messages: [{ role: "user", content: [{ type: "text", text: "token=abcdefghijklmnopqrstuvwxyz123456" }] }] } as any,
      {},
      services,
    );
    expect(observed).toContain("REDACTED");
    expect(observed).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});
