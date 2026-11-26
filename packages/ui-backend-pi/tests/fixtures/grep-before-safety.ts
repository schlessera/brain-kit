/** Pre-safety grepTool implementation, copied verbatim from main
 * 134c0eee935f1c88ddbef5f1f59aee8b2363fe3a for byte-compatibility proof. */
import { spawn } from "bun";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {killWrapped,wrapCommand} from "@schlessera/brain-ui-sdk/server";
import {execWrapperSpawnOptions,WORKER_EGRESS_TRANSPORT_ENV} from "@schlessera/brain-ui-sdk/internal";
import {resolveEnabledWebSearchEnvNames,ambientExecConfig,subprocessEnv} from "../../src/config/env.js";
import {clip,textResult,type BrainToolKit} from "../../src/tool-kit.js";
export function baselineGrepTool(kit: BrainToolKit): ToolDefinition {
  const { deps, brain, resolveOrThrow } = kit;
  return {
    name: "grep",
    label: "Grep",
    description:
      "Search file contents in the brain repository with a regular expression. " +
      "Returns matching lines as `path:line: text`.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search for." }),
      path: Type.Optional(
        Type.String({ description: "Repo-relative subtree to search (default: whole repo)." })
      ),
    }),
    async execute(_id: string, params: { pattern: string; path?: string }, signal?: AbortSignal) {
      // Containment: scope the search path to the repo; grep runs with cwd=repo.
      const rel = params.path ?? ".";
      resolveOrThrow(rel);
      const exec = deps.exec ?? ambientExecConfig();
      const proc = spawn(wrapCommand(["grep", "-rInE", "--", params.pattern, rel], exec.wrapper), {
        cwd: brain.root,
        env: subprocessEnv([...resolveEnabledWebSearchEnvNames(), ...WORKER_EGRESS_TRANSPORT_ENV]),
        stdout: "pipe",
        stderr: "pipe",
        ...execWrapperSpawnOptions(exec.wrapper),
      });
      const onAbort = () => killWrapped(proc, exec);
      signal?.addEventListener("abort", onAbort, { once: true });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      signal?.removeEventListener("abort", onAbort);
      const text = out.trim();
      return textResult(text ? clip(text) : "No matches.", { pattern: params.pattern });
    },
  } satisfies ToolDefinition;
}

