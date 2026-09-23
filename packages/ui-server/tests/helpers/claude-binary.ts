/**
 * The Claude Code binary the Agent SDK ships for this platform, from the
 * workspace install. `createApp()` probes the binary a turn would spawn at
 * boot (#211) and refuses to start without one; app-level suites point
 * `CLAUDE_CODE_PATH` here so they boot on the binary the lockfile installs
 * rather than on whatever a developer's host has at the default path.
 */
import { join } from "node:path";

export function bundledClaudeBinary(): string {
  const libc = process.platform === "linux" ? ["", "-musl"] : [""];
  for (const suffix of libc) {
    try {
      return Bun.resolveSync(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/claude`,
        join(import.meta.dir, "../../../ui-backend-claude")
      );
    } catch {
      // try the next libc
    }
  }
  throw new Error("the Agent SDK's bundled Claude Code binary is not installed");
}
