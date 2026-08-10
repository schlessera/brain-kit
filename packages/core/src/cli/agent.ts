import type { AgentRunner } from "../lib/seams.js";

/**
 * Run an agent prompt inside the brain repo, streaming tool activity to stderr
 * (so stdout stays clean for the final text). Mirrors the reference brain's
 * callClaudeStreaming, but works through the injected AgentRunner seam so any
 * configured coding-agent CLI (claude/pi/codex/gemini/custom) can back it.
 */
export async function runAgent(
  runner: AgentRunner,
  prompt: string,
  cwd: string
): Promise<void> {
  if (runner.runStreaming) {
    const text = await runner.runStreaming(prompt, {
      cwd,
      onEvent: (e) => {
        if (e.kind === "tool") process.stderr.write(`  ${e.label}...\n`);
      },
    });
    if (text) console.log(text);
    return;
  }
  const text = await runner.run(prompt, { cwd });
  if (text) console.log(text);
}
