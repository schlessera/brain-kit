import type { AgentRunner, AgentRuntime } from "../lib/seams.js";

/**
 * One agent run as a caller records it (#290): which runner, what the runtime
 * reported about itself while it ran, and how it ended. `runtime` is null when
 * nothing was observed — a runner that does not report, or a run that ended
 * before the runtime spoke — and is never filled in from anything else.
 */
export interface AgentInvocation {
  runner: string;
  outcome: "success" | "failed";
  runtime: { name: string; version: string | null } | null;
  /** The agent's final text; null when it failed. */
  text: string | null;
  /** Why it failed; absent on success. */
  error?: string;
}

/**
 * A run that threw, carrying what it observed before it did: a failure after
 * the runtime reported itself keeps that report.
 */
export class AgentRunError extends Error {
  constructor(readonly invocation: AgentInvocation, cause: unknown) {
    super(invocation.error ?? "agent run failed", { cause });
    this.name = "AgentRunError";
  }
}

/**
 * Run an agent prompt inside the brain repo. By default tool activity streams
 * to stderr and the final text is printed on stdout, as it always was.
 * `quiet` prints nothing, for a caller that emits one JSON result instead.
 * Works through the injected AgentRunner seam so any configured coding-agent
 * CLI (claude/pi/codex/gemini/custom) can back it.
 *
 * Throws {@link AgentRunError} when the run fails.
 */
export async function runAgent(
  runner: AgentRunner,
  prompt: string,
  cwd: string,
  opts: { quiet?: boolean } = {}
): Promise<AgentInvocation> {
  let observed: AgentRuntime | undefined;
  const onRuntime = (runtime: AgentRuntime) => {
    observed ??= runtime;
  };
  const runtime = () => (observed ? { name: observed.name, version: observed.version ?? null } : null);
  let text: string;
  try {
    text = runner.runStreaming
      ? await runner.runStreaming(prompt, {
          cwd,
          onEvent: (e) => {
            if (e.kind === "tool" && !opts.quiet) process.stderr.write(`  ${e.label}...\n`);
          },
          onRuntime,
        })
      : await runner.run(prompt, { cwd, onRuntime });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    throw new AgentRunError({ runner: runner.id, outcome: "failed", runtime: runtime(), text: null, error }, e);
  }
  if (text && !opts.quiet) console.log(text);
  return { runner: runner.id, outcome: "success", runtime: runtime(), text: text || null };
}
