import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

/** The two named, flat groups are the only shared artwork in the master. */
export function extractBrandParts(svg: string): { mark: string; wordmark: string } {
  const group = (id: string) => {
    const matches = [...svg.matchAll(new RegExp(`<g id="${id}">([\\s\\S]*?)</g>`, "g"))];
    assert.equal(matches.length, 1, `Expected one ${id} group in banner.svg`);
    assert(!matches[0][1].includes("<g"), `${id} must remain a flat group`);
    return matches[0][1];
  };
  return { mark: group("smart-compact-mark"), wordmark: group("smart-compact-wordmark") };
}

if (import.meta.main) {
  const root = new URL("../docs/assets/", import.meta.url);
  const banner = readFileSync(new URL("banner.svg", root), "utf8");
  const { mark, wordmark } = extractBrandParts(banner);
  const svg = (width: number, height: number, title: string, body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${title}</title>${body}</svg>\n`;
  const exports = {
    banner,
    emblem: svg(176, 176, "Smart Compact emblem — the bound folio", `<g transform="translate(8 4)">${mark}</g>`),
    logo: svg(720, 144, "Smart Compact", `<g transform="translate(16 10) scale(.75)">${mark}</g><g transform="translate(148 92) scale(1.4)" fill="#17314B">${wordmark}</g>`),
    "logo-dark": svg(720, 144, "Smart Compact — light lettering for dark surfaces", `<g transform="translate(16 10) scale(.75)">${mark}</g><g transform="translate(148 92) scale(1.4)" fill="#F7F9FC">${wordmark}</g>`),
    "pi-smart-compact": svg(512, 512, "Smart Compact package image", `<rect width="512" height="512" rx="112" fill="#EEF3FA"/><g transform="translate(96 80) scale(2)">${mark}</g>`),
  };
  for (const [name, source] of Object.entries(exports)) {
    if (name !== "banner") writeFileSync(new URL(name + ".svg", root), source);
    writeFileSync(new URL(name + ".png", root), new Resvg(source, { font: { loadSystemFonts: false } }).render().asPng());
    console.log(`Rendered ${name}.png`);
  }
}
