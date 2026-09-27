/** Read-only text for `/smart-compact storage`; never suggests that anything is safe to delete. */
import os from "node:os";
import type { ArtifactOwnerStatus, ArtifactStorageReport } from "../app/artifact-storage.ts";

function shortPath(file: string): string {
  const home = os.homedir() + "/";
  return file.startsWith(home) ? "~/" + file.slice(home.length) : file;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return value.toFixed(value < 10 ? 1 : 0) + " " + units[unit];
}

function age(ms: number | null, now: number): string {
  if (ms === null) return "age unknown";
  const days = Math.floor((now - ms) / 86_400_000);
  return days < 1 ? "newest today" : "newest " + days + " d ago";
}

const STATUS_LABEL: Record<ArtifactOwnerStatus["status"], string> = {
  live: "in use",
  "unreferenced-in-scan": "not referenced in scan",
  unknown: "unknown",
};

export function formatStorageReport(report: ArtifactStorageReport, now = Date.now()): string {
  const { totals } = report;
  const lines = ["Smart Compact storage — read-only; nothing was changed or deleted.", ""];
  lines.push("Saved tool output: " + shortPath(report.root));
  if (!report.rootPresent) lines.push("  Nothing stored yet.");
  else if (!report.rootSafe) lines.push("  Not inspected: the path is not a plain directory.");
  else {
    lines.push("  " + totals.owners + " sessions · " + totals.files + " files · " + formatBytes(totals.bytes));
    lines.push(
      "  In use " + formatBytes(totals.liveBytes) +
        " · not referenced in scan " + formatBytes(totals.unreferencedBytes) +
        " · unknown " + formatBytes(totals.unknownBytes),
    );
  }
  lines.push(
    "Scanned: " + shortPath(report.sessionsRoot) + " — " + report.sessionFilesScanned + " session files" +
      (report.sessionFilesUnreadable.length ? ", " + report.sessionFilesUnreadable.length + " unreadable" : "") +
      (report.sessionsRootPresent ? "" : " (folder missing)") +
      (report.scanComplete ? "" : "; scan incomplete, so affected items are unknown"),
  );
  lines.push("Coverage: " + report.coverage + ".");
  lines.push(
    "Sessions kept outside Pi's sessions folder, and output a running session writes later, are not seen. Age is an observation, not an expiry.",
  );
  const flagged = report.owners
    .filter((owner) => owner.status !== "live")
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 5);
  if (flagged.length) {
    lines.push("", "Largest items not proven in use:");
    for (const owner of flagged) {
      lines.push(
        "  " + owner.owner.slice(0, 12) + " · " + STATUS_LABEL[owner.status] + " · " + owner.files + " files · " +
          formatBytes(owner.bytes) + " · " + age(owner.newestMs, now) +
          (owner.reasons.length ? " · " + owner.reasons.join(", ") : ""),
      );
    }
  }
  if (report.foreign.length) {
    lines.push("Other entries in the folder (not Smart Compact files): " + report.foreign.length);
  }
  const { retention } = report;
  lines.push(
    "",
    "Retention: backups keep up to " + retention.backupMaxFiles + " files for " + retention.backupMaxAgeDays +
      " days; the extraction cache is pruned after " + retention.extractionCachePruneDays +
      " days; saved tool output is never deleted automatically.",
  );
  return lines.join("\n");
}
