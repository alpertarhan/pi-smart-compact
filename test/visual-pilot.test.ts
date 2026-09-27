import { beforeAll, describe, expect, it } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildPilotCases, PILOT_LIMITS, runPilot, scorePilotAnswer, type PilotCase } from "../scripts/visual-pilot.ts";

const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5", input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000 } as Model<Api>;
let cases: PilotCase[];
beforeAll(async () => { cases = await buildPilotCases(model); });

describe("bounded synthetic visual pilot", () => {
  it("builds nine paired requests using production image injection without leaking answer keys", () => {
    expect(cases).toHaveLength(PILOT_LIMITS.calls);
    for (const item of cases) {
      // Host timestamps can coincidentally contain numeric answers (e.g. 750).
      // Check delivered text, not accounting metadata or base64 pixel bytes.
      const serialized = JSON.stringify({ ...item.context, messages: item.context.messages.map(message => ({
        role: message.role, content: Array.isArray(message.content) ? message.content.filter(block => block.type !== "image") : message.content,
      })) });
      expect(serialized).not.toContain('"expected"');
      expect(item.context.tools).toBeUndefined();
      for (const question of item.questions.filter(question => question.location === "evidence")) {
        if (item.variant === "text-evidence") expect(serialized).toContain(question.expected);
        else expect(serialized).not.toContain(question.expected);
      }
      const images = item.context.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image") : []);
      expect(images).toHaveLength(item.frames);
      expect(item.frames).toBeLessThanOrEqual(2);
      if (item.scenario === "two-page-reading" && item.variant === "bitmap-evidence") expect(item.frames).toBe(2);
    }
    expect(cases.filter(item => item.variant === "summary").map(item => cases.indexOf(item))).toEqual([0, 5, 7]);
  });

  it("records adaptive width savings without claiming that bitmap beats equivalent text", () => {
    const images = cases.filter(item => item.variant === "bitmap-evidence");
    expect(images.every(item => item.imageTokenEstimate < item.legacyFixedWidthEstimate)).toBe(true);
    expect(images.every(item => item.economics.imageTokens !== null)).toBe(true);
    expect(images.every(item => !item.economics.worthwhile)).toBe(true);
  });

  it("separates fidelity from grounded abstention; missing evidence is not a hallucination", () => {
    const item = cases[0];
    const all = Object.fromEntries(item.questions.map(question => [question.key, question.expected]));
    expect(scorePilotAnswer(JSON.stringify(all), item.questions, "bitmap-evidence")).toMatchObject({ validJson: true, correct: 9, grounded: 9 });
    const grounded = Object.fromEntries(item.questions.map(question => [question.key, question.location === "evidence" ? "UNKNOWN" : question.expected]));
    expect(scorePilotAnswer(JSON.stringify(grounded), item.questions, "summary")).toMatchObject({ validJson: true, correct: 3, grounded: 9 });
    expect(scorePilotAnswer(JSON.stringify(all), item.questions, "summary").grounded).toBe(3);
    expect(scorePilotAnswer("not json", item.questions, "bitmap-evidence")).toMatchObject({ validJson: false, correct: 0 });
    const broken = { ...all, owner: "Cagri Isik", guard: "now > expiresAt" };
    expect(scorePilotAnswer(JSON.stringify(broken), item.questions, "bitmap-evidence").correct).toBe(7);
  });

  it("enforces one-call-at-a-time, output/time/retry limits and preserves provider usage", async () => {
    let calls = 0;
    let active = 0;
    const results = await runPilot(cases, model, { maxTokens: 500_000, maxRetries: 5 }, {
      async complete(_model, _context, options) {
        expect(++active).toBe(1);
        expect(options.maxTokens).toBe(1_024);
        expect(options.maxRetries).toBe(0);
        expect(options.cacheRetention).toBe("none");
        expect(options.codexWatchdogMs).toBe(60_000);
        expect(options.signal).toBeDefined();
        const item = cases[calls++];
        const text = JSON.stringify(Object.fromEntries(item.questions.map(question => [question.key, question.expected])));
        await Promise.resolve();
        active--;
        return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
          usage: { input: 200, output: 30, cacheRead: 12, cacheWrite: 0, totalTokens: 242, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } };
      },
    });
    expect(calls).toBe(9);
    expect(results).toHaveLength(9);
    expect(results[0].usage).toMatchObject({ input: 200, output: 30, cacheRead: 12, totalTokens: 242 });
    expect(JSON.stringify(results)).not.toContain("iVBOR");
  });

  it("stops after the first provider failure and never prints sensitive exception text", async () => {
    let calls = 0;
    const results = await runPilot(cases, model, {}, { complete: async () => { calls++; throw new Error("sensitive credential sentinel"); } });
    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0].usage).toBeNull();
    expect(results[0].error).toBe("Error");
    expect(JSON.stringify(results)).not.toContain("sensitive credential sentinel");
    await expect(runPilot([...cases, cases[0]], model, {}, { complete: async () => { throw Error("must not call"); } })).rejects.toThrow("9 requests");
  });
});
