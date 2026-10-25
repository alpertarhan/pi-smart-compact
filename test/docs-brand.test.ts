import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractBrandParts } from "../scripts/render-brand.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const pages = ["README.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md", "assets/README.md",
  ...readdirSync(path.join(root, "docs")).filter(file => file.endsWith(".md")).map(file => "docs/" + file)];
const withoutCode = (text: string) => text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");

function anchors(text: string): Set<string> {
  const values = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of withoutCode(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = match[1].trim().toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
    const count = counts.get(slug) ?? 0;
    values.add(slug + (count ? "-" + count : ""));
    counts.set(slug, count + 1);
  }
  for (const match of text.matchAll(/<a\s+id="([^"]+)"/g)) values.add(match[1]);
  return values;
}

describe("documentation and visual identity", () => {
  it("keeps current public pages and package metadata on one product name", () => {
    for (const page of pages.filter(page => page !== "docs/identity.md")) {
      expect(read(page), page).not.toMatch(/Pi\s+Continuity/);
    }
    const manifest = JSON.parse(read("package.json"));
    expect(manifest.name).toBe("pi-smart-compact");
    expect(manifest.description).toStartWith("Smart Compact");
    expect(manifest.keywords).not.toContain("pi-continuity");
    expect(manifest.pi.image).toEndWith("/docs/assets/pi-smart-compact.png?v=3");
    expect(read("README.md")).toContain("# Smart Compact");
  });

  it("keeps literal local document and image links reachable, including heading targets", () => {
    const failures: string[] = [];
    for (const page of pages) {
      const content = withoutCode(read(page));
      const urls = [...content.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1]);
      urls.push(...[...content.matchAll(/(?:src|srcset)="([^"]+)"/g)].map(match => match[1]));
      for (const url of urls) {
        if (/^(?:[a-z]+:|\/\/)/i.test(url)) continue;
        const [file, fragment] = url.split("#", 2);
        const target = file ? path.resolve(root, path.dirname(page), decodeURIComponent(file.split("?")[0])) : path.join(root, page);
        if (!existsSync(target)) failures.push(`${page}: missing ${url}`);
        else if (fragment && target.endsWith(".md") && !anchors(readFileSync(target, "utf8")).has(decodeURIComponent(fragment))) {
          failures.push(`${page}: missing heading ${url}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("extracts the two shared, flat master groups and rejects incomplete artwork", () => {
    const parts = extractBrandParts(read("docs/assets/banner.svg"));
    expect(parts.mark).toContain("#DCA653");
    expect(parts.wordmark).toContain("<path");
    expect(() => extractBrandParts("<svg/>")).toThrow("smart-compact-mark");
    expect(() => extractBrandParts('<g id="smart-compact-mark"><g/></g>')).toThrow("flat group");
    expect(() => extractBrandParts('<g id="smart-compact-mark"></g><g id="smart-compact-mark"></g>')).toThrow("one smart-compact-mark");
  });

  it("ships accessible, self-contained SVGs and PNGs at their documented dimensions", () => {
    const dimensions = { banner: [1600, 720], emblem: [176, 176], logo: [720, 144], "logo-dark": [720, 144], "pi-smart-compact": [512, 512] };
    for (const [name, [width, height]] of Object.entries(dimensions)) {
      const svg = read(`docs/assets/${name}.svg`);
      expect(svg, name).toContain(`<title id="title">Smart Compact`);
      expect(svg, name).toContain('role="img"');
      expect(svg, name).not.toMatch(/<text\b|<image\b|<script\b|<foreignObject\b|@font-face/);
      expect(svg, name).not.toMatch(/(?:href|src)="(?!#)/);
      const png = readFileSync(path.join(root, `docs/assets/${name}.png`));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(height);
      expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
    }
  });
});
