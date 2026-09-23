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

import { inheritedEnv } from "../../config/env.js";
import { claudeExecutable } from "./claude-binary.js";
import type { AgentRunner } from "../../lib/seams.js";
import {
  CLEARED_API_CREDENTIALS,
  ClaudeSubscriptionError,
  NEUTRALISED_SETTINGS,
  settingsRefusal,
  subscriptionRefusal,
  type ClaudeAccount,
  type CliSettingsReport,
} from "./claude-subscription.js";

// Safety net: a hung agent CLI session must not block the caller forever.
const DEFAULT_TIMEOUT_MS = 300_000;

/** The ids of the two control requests a Claude run sends before its prompt. */
const INITIALIZE_REQUEST_ID = "brain-initialize";
const SETTINGS_REQUEST_ID = "brain-settings";

/** Everything after the command, which `claudeExecutable()` decides per run. */
const CLAUDE_BASE_ARGS = [
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

type RunnerEvent = { kind: "tool" | "text"; label: string };

/**
 * One Claude Code run over stream-json, held to the subscription
 * (claude-subscription.ts). The API credential variables are cleared and any
 * `apiKeyHelper` switched off; then the CLI's `initialize` handshake reports
 * which account it selected, and the prompt is written only if that account is
 * a subscription. A refused run never sends anything to the model.
 *
 * Tool activity streams to `onEvent` as it happens; the final result text is
 * returned. Ported from agent-commands.ts's callClaudeStreaming.
 */
async function claudeSession(
  prompt: string,
  opts: { cwd: string; timeoutMs: number; onEvent?: (e: RunnerEvent) => void }
): Promise<string> {
  const proc = Bun.spawn(
    [
      claudeExecutable(),
      ...CLAUDE_BASE_ARGS,
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--settings",
      JSON.stringify(NEUTRALISED_SETTINGS),
    ],
    {
      cwd: opts.cwd,
      env: inheritedEnv(CLEARED_API_CREDENTIALS),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(opts.timeoutMs),
    }
  );
  const send = (message: unknown) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  const stderr = new Response(proc.stderr).text();
  send({ type: "control_request", request_id: INITIALIZE_REQUEST_ID, request: { subtype: "initialize" } });
  send({ type: "control_request", request_id: SETTINGS_REQUEST_ID, request: { subtype: "get_settings" } });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let resultText = "";
  let sawResult = false;
  let refusal: string | null = null;
  let promptSent = false;
  // Both answers are needed before the prompt may be written.
  let account: { reply: unknown } | undefined;
  let settings: { reply: unknown } | undefined;

  read: for (;;) {
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

      if (!promptSent && event.type === "control_response") {
        const id = event.response?.request_id;
        if (id !== INITIALIZE_REQUEST_ID && id !== SETTINGS_REQUEST_ID) continue;
        if (event.response.subtype !== "success") {
          refusal = `the CLI refused its ${id === INITIALIZE_REQUEST_ID ? "handshake" : "settings request"}: ${
            event.response.error ?? "unknown error"
          }`;
        } else if (id === INITIALIZE_REQUEST_ID) {
          account = { reply: event.response.response?.account };
        } else {
          settings = { reply: event.response.response };
        }
        if (!refusal && account && settings) {
          refusal =
            subscriptionRefusal(account.reply as ClaudeAccount | undefined) ??
            settingsRefusal(settings.reply as CliSettingsReport | undefined);
        }
        if (refusal) {
          proc.kill();
          break read;
        }
        if (!account || !settings) continue;
        promptSent = true;
        send({
          type: "user",
          message: { role: "user", content: prompt },
          parent_tool_use_id: null,
          session_id: "",
        });
        continue;
      }

      if (event.type === "assistant" && Array.isArray(event.message?.content) && opts.onEvent) {
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

      if (event.type === "result") {
        sawResult = true;
        if (typeof event.result === "string") resultText = event.result;
        // One prompt, one result: closing stdin lets the CLI exit.
        proc.stdin.end();
      }
    }
  }

  const exitCode = await proc.exited;
  if (refusal) throw new ClaudeSubscriptionError(refusal);
  if (!promptSent) {
    throw new Error(`claude CLI exited before its handshake (exit ${exitCode}): ${(await stderr).trim() || "(no stderr)"}`);
  }
  if (exitCode !== 0) {
    throw new Error(`claude CLI failed (exit ${exitCode}): ${resultText || (await stderr).trim() || "(no output)"}`);
  }
  if (!sawResult) {
    throw new Error(`claude CLI ended without a result: ${(await stderr).trim() || "(no stderr)"}`);
  }
  return resultText.trim();
}

/** claude — `claude --print` over stream-json, held to the subscription. */
export function claudeRunner(): AgentRunner {
  return {
    id: "claude",
    capabilities: { streaming: true, skills: true },
    run(prompt, opts) {
      return claudeSession(prompt, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    },
    runStreaming(prompt, opts) {
      return claudeSession(prompt, { cwd: opts.cwd, timeoutMs: DEFAULT_TIMEOUT_MS, onEvent: opts.onEvent });
    },
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
