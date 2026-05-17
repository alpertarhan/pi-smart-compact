/**
 * Type guards and utility functions for content block inspection.
 * Extracted from types.ts to keep type definitions pure.
 */

/** Type guard for text content blocks */
export function isTextBlock(c: unknown): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string";
}

/** Type guard for tool call content blocks */
export function isToolCallBlock(c: unknown): c is { type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown> } {
  return typeof c === "object" && c !== null && (c as { type?: string }).type === "toolCall" && typeof (c as { name?: unknown }).name === "string";
}

/** Get tool call names from unknown content */
export function getToolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isToolCallBlock).map(b => b.name);
}

/** Filter tool call blocks from unknown content */
export function filterToolCalls(content: unknown): Array<{ type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  return content.filter(isToolCallBlock);
}
