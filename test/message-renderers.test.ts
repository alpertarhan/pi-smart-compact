import { describe, expect, it } from "bun:test";
import smartCompactExtension from "../src/index.ts";
import { createMessageRenderers, MEMORY_STATUS_TYPE } from "../src/ui/message-renderers.ts";
import { ANCHOR_CUSTOM_TYPE } from "../src/app/navigation-data.ts";

/** Wraps text in visible tags so tests assert the SEMANTIC color consulted. */
const theme: any = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => `<b>${text}</b>` };

function lines(renderer: any, message: unknown, expanded = false): string[] {
 return renderer(message, { expanded, outputPad: 1, keyText: () => "", keyHint: () => "ctrl+o to expand" }, theme)
  .render(200).map((line: any) => String(typeof line === "string" ? line : line.text).trimEnd());
}

const details = (extra: Record<string, unknown>) => ({ customType: MEMORY_STATUS_TYPE, role: "custom", display: true, timestamp: 0, content: "<memory_status>model text</memory_status>", details: extra });

describe("message renderers", () => {
 it("are registered at extension load, whatever the backend or navigation settings", () => {
  const types: string[] = [];
  smartCompactExtension({ registerMessageRenderer: (type: string) => types.push(type), on() {}, registerTool() {}, registerCommand() {}, getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [] } as any);
  expect(types.sort()).toEqual([ANCHOR_CUSTOM_TYPE, MEMORY_STATUS_TYPE].sort());
 });

 it("shows the four memory states in plain words, without the model's text or XML", () => {
  const renderers = createMessageRenderers();
  const render = (state: string, extra: Record<string, unknown> = {}, expanded = false) =>
   lines(renderers[MEMORY_STATUS_TYPE], details({ state, ref: "hindsight:cg-0123456789abcdef01234567@4f4ac0c7b424879350f26717", ...extra }), expanded).join("\n");

  const completed = render("completed", { title: "Use pnpm, never npm" });
  expect(completed).toContain("<success>done</> <muted>saved to Hindsight</>\n<dim>Use pnpm, never npm</>");
  expect(completed).toContain("expand"); // a hint in place of the ref, as every tool row does (its keybinding text is the host's)
  expect(render("accepted")).toContain("<warning>pending</> <muted>Hindsight is still indexing it; not searchable yet</>");
  expect(render("failed", { reason: "bank rejected the document: schema mismatch" })).toContain("<error>failed</> <muted>not saved to Hindsight</>\n<dim>bank rejected the document: schema mismatch</>");
  expect(render("unknown", { reason: "HTTP 504 after 30s" })).toContain("Hindsight result unknown</>\n<dim>HTTP 504 after 30s</>");

  // Identifiers stay out of the collapsed line and appear only on expand, like every tool row.
  const collapsed = render("completed", { title: "t" });
  expect(collapsed).not.toContain("hindsight:cg-");
  expect(collapsed).not.toContain("<memory_status");
  expect(collapsed).not.toContain("model text");
  const expanded = render("completed", { title: "t" }, true);
  expect(expanded).toContain("hindsight:cg-0123456789abcdef01234567@4f4ac0c7b424879350f26717");
  expect(expanded).not.toContain("expand");
 });

 it("names the time limit without turning a still-pending save into a failure", () => {
  const rendered = lines(createMessageRenderers()[MEMORY_STATUS_TYPE],
   details({ state: "accepted", expired: true, lastError: "HTTP 504" }));
  expect(rendered[0]).toContain("<warning>pending</>");
  expect(rendered[0]).not.toContain("<error>");
  // The failed status check and the time limit are each named, on their own dim lines.
  expect(rendered[1]).toBe("<dim>HTTP 504</>");
  expect(rendered.join("\n")).toContain("time limit");
 });

 it("summarises earlier saves in one line", () => {
  const [line] = lines(createMessageRenderers()[MEMORY_STATUS_TYPE], details({ state: "summary", total: 4, counts: { completed: 1, failed: 1, accepted: 1, unknown: 1 } }));
  expect(line).toBe("<success>done</> <muted>4 earlier Hindsight saves: 1 completed, 1 failed, 1 accepted, 1 unknown</>");
 });

 it("shows an unknown or missing state as pending, never as success", () => {
  const renderers = createMessageRenderers();
  expect(lines(renderers[MEMORY_STATUS_TYPE], details({}))[0]).toContain("<warning>pending</>");
  expect(lines(renderers[MEMORY_STATUS_TYPE], details({}))[0]).not.toContain("<success>");
 });

 it("collapses an anchor to one line and shows the summary only when expanded", () => {
  const renderers = createMessageRenderers();
  const message = { customType: ANCHOR_CUSTOM_TYPE, content: "Anchor: post-refactor\n\nSUMMARY-BODY", details: { anchor: { name: "post-refactor", summary: "SUMMARY-BODY", targetId: "t1" } } };
  expect(lines(renderers[ANCHOR_CUSTOM_TYPE], message)).toEqual(["<success>done</> <muted>anchor recorded: post-refactor</>"]);
  expect(lines(renderers[ANCHOR_CUSTOM_TYPE], message, true).join("\n")).toBe("<success>done</> <muted>anchor recorded: post-refactor</>\n<dim>SUMMARY-BODY</>");
 });

 it("falls back to plain text for a malformed anchor instead of throwing", () => {
  expect(lines(createMessageRenderers()[ANCHOR_CUSTOM_TYPE], { customType: ANCHOR_CUSTOM_TYPE, content: "Anchor: x", details: { anchor: { name: 7 } } })).toEqual(["<muted>Anchor</>"]);
 });
});
