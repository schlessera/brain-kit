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
  run(prompt: string, opts: { cwd: string; timeoutMs?: number }): Promise<string>;
  runStreaming?(
    prompt: string,
    opts: {
      cwd: string;
      onEvent: (e: { kind: "tool" | "text"; label: string }) => void;
    }
  ): Promise<string>;
}
```

`run` executes the agent against a prompt in `cwd` and returns its final text.
`runStreaming` is optional — implement it to surface tool activity as it happens.
`capabilities.skills` declares whether the agent discovers the brain's skills.

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
until v0.1; `claude` and `codex` are ported from a working implementation. If you
depend on `pi` or `gemini` today, verify the flag against your installed CLI or
pass a custom runner.

## Add your own (≤3 steps)

1. **Implement `AgentRunner`** — typically a thin shell-out:

   ```ts
   // my-runner.ts
   import type { AgentRunner } from "@schlessera/brain";

   export function myRunner(): AgentRunner {
     return {
       id: "mine",
       capabilities: { streaming: false, skills: true },
       async run(prompt, { cwd, timeoutMs }) {
         /* spawn your agent CLI in cwd, return its final text */
       },
     };
   }
   ```

2. **Reference it by value:**

   ```ts
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
that `timeoutMs` is honoured, and that `runStreaming` surfaces tool activity.
Give it two runners wired to a fake agent — one that uses a tool and then
answers with its working directory and the prompt
(`` `${process.cwd()}\n${prompt}` ``), and one that never finishes:

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
