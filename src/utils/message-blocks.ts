import type { LlmContentBlock, LlmMessage, LlmTextBlock, LlmToolCallBlock } from "../types";

export function getBlocks(message: Pick<LlmMessage, "content">): LlmContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function isTextBlock(block: LlmContentBlock): block is LlmTextBlock {
  return typeof block !== "string" && block.type === "text";
}

export function isToolCallBlock(block: LlmContentBlock): block is LlmToolCallBlock {
  return typeof block !== "string" && block.type === "toolCall";
}

export function getToolArgumentString(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}
