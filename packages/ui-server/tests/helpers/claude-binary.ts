/**
 * The Claude Code binary the Agent SDK selects when it is given no path: the
 * backend's own copy of the SDK, asked directly, so the answer follows its
 * platform and libc rules rather than a copy of them. `createApp()` probes the
 * binary a turn would spawn at boot (#211); app-level suites boot on this one.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

type Query = typeof import("@anthropic-ai/claude-agent-sdk").query;

export function bundledClaudeBinary(): string {
  const sdk = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../../../ui-backend-claude"));
  const { query } = require(sdk) as { query: Query };
  let command: string | undefined;
  try {
    query({
      prompt: "",
      options: {
        cwd: tmpdir(),
        spawnClaudeCodeProcess: (spawn) => {
          command = spawn.command;
          throw new Error("captured");
        },
      },
    });
  } catch {
    // the capture
  }
  if (!command) throw new Error("the Agent SDK did not select a Claude Code binary");
  return command;
}
