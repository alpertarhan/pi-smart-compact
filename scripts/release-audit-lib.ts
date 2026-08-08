export function getNpmPackFilename(result: unknown): string | null {
  const entries = Array.isArray(result)
    ? result
    : result && typeof result === "object" ? Object.values(result) : [];
  const filename = entries.find(entry => entry && typeof entry === "object" && typeof (entry as { filename?: unknown }).filename === "string");
  return filename ? (filename as { filename: string }).filename : null;
}
