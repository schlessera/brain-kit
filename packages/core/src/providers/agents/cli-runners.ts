/**
 * Built-in AgentRunner implementations — plain CLI shell-outs.
 *
 * Each runner spawns a coding-agent CLI in non-interactive mode inside a repo.
 * Flag provenance:
 *   - claude: `claude --print` + streaming shape ported verbatim from the
 *     reference brain's agent-commands.ts.
 *   - codex:  flags derived from whatsup's `codex exec` backend.
 *   - gemini: NOT present in the reference (whatsup calls the Gemini API, not a
 *     CLI). Uses the Gemini CLI's documented `-p/--prompt` non-interactive flag
 *     — UNVERIFIED against a pinned CLI version.
 *   - pi:     NOT present in the reference. Uses a claude-style `-p` print flag
 *     — UNVERIFIED; pi's headless surface is `--mode rpc` (NDJSON), so this
 *     simple shell-out may need revisiting when the pi CLI is pinned.
 */

import type { AgentRunner } from "../../lib/seams";

// Safety net: a hung agent CLI session must not block the caller forever.
const DEFAULT_TIMEOUT_MS = 300_000;

const CLAUDE_BASE_ARGS = [
  "claude",
  "--print",
  "--allowed-tools",
  "Bash,Edit,Write,Read,Glob,Grep",
];

/**
 * Spawn a CLI, drain stdout+stderr concurrently (avoids pipe-buffer deadlock),
 * and fail loudly on non-zero exit or a timeout abort.
 */
async function spawnCollect(
  args: string[],
  opts: { cwd: string; timeoutMs: number; stdin?: string }
): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    ...(opts.stdin !== undefined ? { stdin: new TextEncoder().encode(opts.stdin) } : {}),
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(opts.timeoutMs),
  });

  const [output, errText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`${args[0]} CLI failed (exit ${exitCode}): ${errText.trim() || "(no stderr)"}`);
  }
  return output.trim();
}

/**
 * Claude Code CLI with streaming progress. Uses --output-format stream-json to
 * surface tool activity as it happens; the final result text is returned.
 * Ported from agent-commands.ts's callClaudeStreaming.
 */
async function claudeRunStreaming(
  prompt: string,
  opts: { cwd: string; onEvent: (e: { kind: "tool" | "text"; label: string }) => void }
): Promise<string> {
  const proc = Bun.spawn([...CLAUDE_BASE_ARGS, "--verbose", "--output-format", "stream-json"], {
    cwd: opts.cwd,
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "inherit",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let resultText = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // Skip unparseable lines.
      }

      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "tool_use") {
            const input = block.input || {};
            const detail = input.command || input.pattern || input.file_path || input.prompt || "";
            const short = typeof detail === "string" ? detail.slice(0, 80) : "";
            opts.onEvent({ kind: "tool", label: `${block.name}${short ? `: ${short}` : ""}` });
          } else if (block.type === "text" && typeof block.text === "string") {
            opts.onEvent({ kind: "text", label: block.text });
          }
        }
      }

      if (event.type === "result" && event.result) {
        resultText = event.result;
      }
    }
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`claude CLI failed (exit ${exitCode})`);
  }
  return resultText;
}

/** claude — `claude --print`, prompt piped via stdin (avoids arg-parsing issues). */
export function claudeRunner(): AgentRunner {
  return {
    id: "claude",
    capabilities: { streaming: true, skills: true },
    run(prompt, opts) {
      return spawnCollect(CLAUDE_BASE_ARGS, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        stdin: prompt,
      });
    },
    runStreaming: claudeRunStreaming,
  };
}

/** codex — `codex exec --full-auto --ephemeral`, prompt as positional arg. */
export function codexRunner(): AgentRunner {
  return {
    id: "codex",
    capabilities: { streaming: false, skills: true },
    run(prompt, opts) {
      return spawnCollect(["codex", "exec", "--full-auto", "--ephemeral", "-C", opts.cwd, prompt], {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
  };
}

/** gemini — `gemini -p <prompt>` (non-interactive). UNVERIFIED flag. */
export function geminiRunner(): AgentRunner {
  return {
    id: "gemini",
    capabilities: { streaming: false, skills: true },
    run(prompt, opts) {
      return spawnCollect(["gemini", "-p", prompt], {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
  };
}

/** pi — `pi -p <prompt>` (non-interactive). UNVERIFIED flag. */
export function piRunner(): AgentRunner {
  return {
    id: "pi",
    capabilities: { streaming: false, skills: true },
    run(prompt, opts) {
      return spawnCollect(["pi", "-p", prompt], {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
  };
}
