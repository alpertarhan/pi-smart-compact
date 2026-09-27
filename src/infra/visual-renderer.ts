/** Optional, lazy Node-compatible rasterization. No raw SVG, paths, or URLs from users. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VisualArchive } from "../types.ts";

export const VISUAL_WIDTH = 1280;
export const VISUAL_COLUMNS = 138;
export const VISUAL_ROWS = 74;
export const VISUAL_MAX_FRAMES = 2;
export const VISUAL_MAX_BYTES = 1_000_000;
export const VISUAL_MIN_WIDTH = 256;

/** Crop whitespace, not glyph size. Nine pixels safely covers the bundled 14px mono font. */
export function visualPageSize(lines: readonly string[]) {
  const columns = Math.max(0, ...lines.map(line => Array.from(line).length));
  return { width: Math.min(VISUAL_WIDTH, Math.max(VISUAL_MIN_WIDTH, Math.ceil((32 + columns * 9) / 32) * 32)),
    height: 32 + lines.length * 20 };
}

/** Conservative request-planning allowance, not measured provider billing. */
export function estimateVisualTokens(width: number, height: number): number {
  return 256 + Math.ceil(width / 32) * Math.ceil(height / 32) * 3;
}

function fontPath(): string {
  // Source tests live in src/infra; the published single bundle lives in dist.
  for (const relative of ["../assets/DejaVuSansMono.ttf", "../../assets/DejaVuSansMono.ttf"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error("Visual archive font is unavailable");
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function renderVisualPages(pages: string[][], signal: AbortSignal): Promise<VisualArchive["frames"]> {
  if (!pages.length || pages.length > VISUAL_MAX_FRAMES
    || pages.some(lines => !lines.length || lines.length > VISUAL_ROWS
      || lines.some(line => Array.from(line).length > VISUAL_COLUMNS))) throw new Error("Invalid visual page bounds");
  signal.throwIfAborted();
  const { renderAsync } = await import("@resvg/resvg-js");
  const font = fontPath();
  const frames: VisualArchive["frames"] = [];
  let bytes = 0;
  for (const lines of pages) {
    signal.throwIfAborted();
    const { width, height } = visualPageSize(lines);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="DejaVu Sans Mono" font-size="14" xml:space="preserve">`
      + lines.map((line, index) => `<text x="16" y="${30 + index * 20}">${xml(line)}</text>`).join("") + "</g></svg>";
    // resvg's native AbortSignal binding is single-use, even after a completed render.
    const rendered = await renderAsync(svg, { font: { loadSystemFonts: false, fontFiles: [font] } }, AbortSignal.any([signal]));
    signal.throwIfAborted();
    const png = rendered.asPng();
    bytes += png.length;
    if (bytes > VISUAL_MAX_BYTES) throw new Error("Visual archive exceeds PNG byte budget");
    frames.push({ data: png.toString("base64"), width: rendered.width, height: rendered.height });
  }
  return frames;
}
