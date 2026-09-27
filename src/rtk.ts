/** Optional companion. Explicitly load this entry point; never auto-loaded by Smart Compact.
 * Delegates rules to RTK's public `rewrite` CLI; requires >=0.50 for the tested recall behavior.
 * No RTK source or filtering rules are bundled. https://github.com/rtk-ai/rtk/tree/master/hooks/pi
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reportIssue } from "./utils/issues.ts";

export default function rtkCompanion(pi: Pick<ExtensionAPI, "on" | "exec">): void {
  let generation = 0;
  let available: Promise<boolean> | undefined;
  const reset = () => { generation++; available = undefined; };
  pi.on("session_start", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || process.env.RTK_DISABLED === "1" || ctx.signal?.aborted) return;
    const command = event.input.command;
    if (typeof command !== "string" || !command.trim() || command.length > 32_768 || /^\s*rtk(?:\s|$)/.test(command)) return;
    // No shell parser: compound commands/redirections/substitutions stay untouched,
    // including quoted operators. Filtering data fed to another command is not safe.
    if (/[|;&<>\n\r\u0000`$()]/.test(command)) return;
    // Eligibility, NOT rewrite rules. The local pilot lost unreferenced git-diff
    // evidence, grew tsc output, and dropped vitest 5 failure text; bun test kept
    // exit codes, failure/load-error evidence and recall parity. Expand only
    // after command-specific fidelity checks.
    if (!/^\s*(?:git\s+status|cargo\s+test|bun\s+test)\s*$/.test(command)) return;
    const started = generation;
    try {
      available ??= pi.exec("rtk", ["--version"], { timeout: 2_000, signal: ctx.signal }).then(result => {
        const version = /^rtk\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(result.stdout.trim());
        return !result.killed && result.code === 0 && Boolean(version && (+version[1] > 0 || +version[2] >= 50));
      }).catch(() => false);
      if (!await available) {
        if (started === generation && !ctx.signal?.aborted) {
          reportIssue({
            key: "rtk.inactive",
            message: "RTK rewriting is inactive: requires rtk >=0.50 in PATH. Commands run unchanged. Install or update rtk, or stop loading the RTK companion.",
          }, ctx);
        }
        return;
      }
      if (started !== generation || ctx.signal?.aborted) return;
      const result = await pi.exec("rtk", ["rewrite", command], { timeout: 2_000, signal: ctx.signal });
      const rewritten = result.stdout.trim();
      if (started !== generation || ctx.signal?.aborted || process.env.RTK_DISABLED === "1" || event.input.command !== command || result.killed
        || ![0, 3].includes(result.code) || !/^rtk\s/.test(rewritten) || rewritten.length > 32_768
        || /[|;&<>\n\r\u0000`$()]/.test(rewritten)) return;
      // Native bash executes once. Never retry the original command after an RTK execution failure.
      event.input.command = rewritten;
    } catch {
      // Rewrite/probe failure must neither block nor execute the user's command.
    }
  });
}
