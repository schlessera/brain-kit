# Extending: agent runners

The `AgentRunner` seam is an **agentic** run inside your repo — it shells out to
a coding-agent CLI in non-interactive mode. Core uses it for skill-invoking flows
that need tools (reading files, running commands), where a plain
[completion](completions.md) is not enough.

## The interface

From `@schlessera/brain` (`src/lib/seams.ts`):

```ts
export interface AgentRunner {
  id: string;
  capabilities: { streaming: boolean; skills: boolean };
  run(
    prompt: string,
    opts: { cwd: string; timeoutMs?: number; onRuntime?: (runtime: AgentRuntime) => void }
  ): Promise<string>;
  runStreaming?(
    prompt: string,
    opts: {
      cwd: string;
      onEvent: (e: { kind: "tool" | "text"; label: string }) => void;
      onRuntime?: (runtime: AgentRuntime) => void;
    }
  ): Promise<string>;
}

export interface AgentRuntime {
  name: string; // e.g. "claude-code"
  version?: string;
}
```

`run` executes the agent against a prompt in `cwd` and returns its final text.
`runStreaming` is optional — implement it to surface tool activity as it happens.
`capabilities.skills` declares whether the agent discovers the brain's skills.

`onRuntime` (optional, added in 0.40.0) is how a runner says what actually
executed the run. Call it once, as soon as the agent reports its own name and
version, and before the run can still fail, so a caller keeps the report when
the run then throws. Report only what the run itself said: never probe a
binary or read an installation to fill it in, and leave `version` out when the
agent named itself without one. A runner that cannot tell simply never calls
it, and `brain sync --json` then records the agent as invoked with an unknown
runtime. The built-in `claude` runner reports the `claude_code_version` of
the session's `system`/`init` event as `{ name: "claude-code", version }`;
the other built-ins do not report.

## Built-ins

| Name     | Command                                      | Streaming | Notes                                     |
| -------- | -------------------------------------------- | --------- | ----------------------------------------- |
| `claude` | `claude --print` (prompt via stdin)          | yes       | Default. Ported from the reference brain. |
| `codex`  | `codex exec --full-auto --ephemeral -C <cwd>`| no        | Derived from the reference implementation.|
| `pi`     | `pi -p <prompt>`                             | no        | Flag being finalized before release.[^1]  |
| `gemini` | `gemini -p <prompt>`                         | no        | Flag being finalized before release.[^1]  |

`claude` is the default when `agentRunner` is omitted.

```ts
agentRunner: "claude"
```

[^1]: The `pi` and `gemini` runners are implemented, but their non-interactive
CLI flags are not yet pinned against a released CLI version (pi's headless
surface, for instance, may move to its RPC mode). Treat these two as provisional
until verified against the CLI you use; keyless contract tests use stand-ins
and do not prove live authentication or upstream flag compatibility. If you
depend on `pi` or `gemini` today, verify the flag against your installed CLI or
pass a custom runner.

## Add your own (≤3 steps)

1. **Implement `AgentRunner`** — typically a thin shell-out. This sketch
   deliberately throws until you implement process creation and return its
   final text:

   ```ts
   // my-runner.ts
   import type { AgentRunner } from "@schlessera/brain";

   export function myRunner(): AgentRunner {
     return {
       id: "mine",
       capabilities: { streaming: false, skills: true },
       async run(prompt, { cwd, timeoutMs }) {
         throw new Error("Implement spawning the agent in cwd and returning its final text");
       },
     };
   }
   ```

2. **Reference it by value:**

   ```ts
   import { defineConfig } from "@schlessera/brain";
   import { myRunner } from "./my-runner";
   export default defineConfig({ agentRunner: myRunner() });
   ```

3. **(Optional) publish** as `brain-agent-<vendor>` (or use any `id` string,
   e.g. `"omp"`, when you pass a value).

## Test it against the contract

`@schlessera/brain/testing` exports `runAgentRunnerContract`, the suite the
four built-in runners run against stand-in CLIs in
`packages/core/tests/agent-runner-contracts.test.ts`. It asserts that
`capabilities.streaming` agrees with whether `runStreaming` exists, that
`run` executes in `cwd` on the prompt and resolves to the agent's final text,
that `timeoutMs` is honoured, and that `runStreaming` surfaces tool activity
as it happens. Give it two runners wired to a fake agent. The first uses a
tool, waits until the file named by the exported `TOOL_EVENT_SEEN_FILE`
exists in its working directory, then answers with that directory and the
prompt (`` `${process.cwd()}\n${prompt}` ``). The suite creates the file
before `run`, and under `runStreaming` only once your runner has delivered
the tool event, so a runner that holds events back until the end never
finishes. The second runner's agent never finishes at all:

```ts
import { describe, expect, test } from "bun:test";
import { runAgentRunnerContract } from "@schlessera/brain/testing";

runAgentRunnerContract(
  { name: "mine", echoing: () => myRunner(echoingAgent), hanging: () => myRunner(hangingAgent) },
  { describe, expect, test }
);
```

A runner that spawns its CLI by name resolves it against the `PATH` the test
process started with, so point the runner at the stand-in directly, or start
the test process with a `PATH` that holds only stand-ins, as the built-ins'
test does.

Some cases wait on a deadline for up to a few seconds, so run the suite with a per-test timeout above bun's default 5s (`bun test --timeout 30000`, as this repository does).

## Capability and degradation notes

- **`capabilities.streaming: false`** → callers that want progress fall back to a
  single result at the end; nothing breaks.
- **`capabilities.skills: false`** → the agent runs without discovering the
  brain's skills. It can still act on the prompt.
- **Agent runners vs. completions.** Use a completion provider for cheap
  text-in/text-out work (it needs no CLI and no repo). Reach for an agent runner
  only when the task genuinely needs tools inside the repo.

## See also

- [completions.md](completions.md) — the cheaper, non-agentic path.
- [skill-emitters.md](skill-emitters.md) — making skills discoverable per agent.
- [README.md](README.md) — the seam meta-mechanism.
- [../configuration.md](../configuration.md#agentrunner) — the `agentRunner` config key.
