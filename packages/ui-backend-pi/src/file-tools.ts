/**
 * The curated file and shell tools (#2517): `read_file`, `grep`,
 * `write_file`, `edit_file` and `bash`, one named factory each. Every factory
 * reads the shared per-roster state from its `BrainToolKit`; `createBrainTools`
 * in tools.ts decides the roster order.
 */
import { spawn } from "bun";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { Type } from "typebox";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bashLockKey, killWrapped, rtkRewriteCommand, wrapCommand } from "@schlessera/brain-ui-sdk/server";
import { RTK_WORKER_ENV, execWrapperSpawnOptions, WORKER_DATA_ROOT, WORKER_EGRESS_TRANSPORT_ENV } from "@schlessera/brain-ui-sdk/internal";

import { resolveEnabledWebSearchEnvNames, ambientExecConfig, subprocessEnv } from "./config/env.js";
import { clip, MAX_READ_BYTES, textResult, type BrainToolKit } from "./tool-kit.js";
import { revalidatePiAdmission } from "./tool-admission.js";

/** `read_file`: one repo-contained UTF-8 file, remembered as a same-turn base. */
export function readFileTool(kit: BrainToolKit): ToolDefinition {
  const { deps, turn, resolveOrThrow, rememberHash } = kit;
  return {
    name: "read_file",
    label: "Read file",
    description:
      "Read a UTF-8 text file from the brain repository. Path is relative to the repo root.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path." }),
    }),
    async execute(_id: string, params: { path: string }) {
      const abs = resolveOrThrow(params.path);
      await deps.nativeFileObservation?.("read_start", params.path, _id);
      const bytes = readFileSync(abs);
      await deps.nativeFileObservation?.("read_end", params.path, _id);
      const hash = rememberHash(params.path, createHash("sha256").update(bytes).digest("hex"));
      return textResult(clip(bytes.toString("utf-8"), MAX_READ_BYTES), { path: params.path, ...(turn.bridge?.applyBrain ? { expectedBaseHash: hash } : {}) });
    },
  } satisfies ToolDefinition;
}

/** `grep`: a regular-expression search scoped to the repository. */
export function grepTool(kit: BrainToolKit): ToolDefinition {
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

/** `write_file`: create or overwrite one file under its own path lock. */
export function writeFileTool(kit: BrainToolKit): ToolDefinition {
  const { deps, lock, resolveOrThrow, rememberBase, assertDirectBase } = kit;
  return {
    name: "write_file",
    label: "Write file",
    description:
      "Create or overwrite a UTF-8 text file in the brain repository. Path is relative to the repo root.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path." }),
      content: Type.String({ description: "Full file contents to write." }),
    }),
    async execute(_id: string, params: { path: string; content: string }) {
      // Per-path lock: writes to the same file serialize, different files run
      // in parallel. Approval (when the gate requires one) already happened
      // in the tool_call event.
      const abs = resolveOrThrow(params.path);
      return lock.withKey(`path:${abs}`, async () => {
        await deps.nativeFileObservation?.("write_check", params.path, _id);
        assertDirectBase(abs);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, params.content, "utf-8");
        rememberBase(params.path, params.content);
        await deps.nativeFileObservation?.("write_end", params.path, _id);
        return textResult(`Wrote ${params.content.length} bytes to ${params.path}.`, {
          path: params.path,
        });
      });
    },
  } satisfies ToolDefinition;
}

/** `edit_file`: replace one unique string under the file's own path lock. */
export function editFileTool(kit: BrainToolKit): ToolDefinition {
  const { deps, lock, resolveOrThrow, rememberBase, assertDirectBase } = kit;
  return {
    name: "edit_file",
    label: "Edit file",
    description:
      "Replace an exact, unique string in a brain-repo file. old_string must occur exactly once.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative file path." }),
      old_string: Type.String({ description: "Exact text to replace (must be unique)." }),
      new_string: Type.String({ description: "Replacement text." }),
    }),
    async execute(
      _id: string,
      params: { path: string; old_string: string; new_string: string }
    ) {
      // Read-modify-write is atomic under the file's own lock key.
      const abs = resolveOrThrow(params.path);
      return lock.withKey(`path:${abs}`, async () => {
        await deps.nativeFileObservation?.("write_check", params.path, _id);
        assertDirectBase(abs);
        const raw = readFileSync(abs, "utf-8");
        const occurrences = raw.split(params.old_string).length - 1;
        if (occurrences === 0) throw new Error(`old_string not found in ${params.path}.`);
        if (occurrences > 1) {
          throw new Error(
            `old_string is not unique in ${params.path} (${occurrences} matches); add more context.`
          );
        }
        writeFileSync(abs, raw.replace(params.old_string, params.new_string), "utf-8");
        rememberBase(params.path, raw.replace(params.old_string, params.new_string));
        await deps.nativeFileObservation?.("write_end", params.path, _id);
        return textResult(`Edited ${params.path}.`, { path: params.path });
      });
    },
  } satisfies ToolDefinition;
}

/** `bash`: one shell command under the shared bash lock-key policy. */
export function bashTool(kit: BrainToolKit): ToolDefinition {
  const { deps, brain, turn, lock } = kit;
  return {
    name: "bash",
    label: "Run bash",
    description:
      (deps.shellCwd === WORKER_DATA_ROOT ? `Run a bash command in this turn's read-only data tree (${WORKER_DATA_ROOT}): the brain's documents with every change this turn applied. Write files under $BRAIN_WORKER_SCRATCH. `
        : deps.shellCwd ? "Run a bash command in writable worker scratch. The authoritative brain is read-only. " : "Run a bash command in the brain repository root. ") + "Combined stdout+stderr is " +
      "returned. Destructive command shapes (recursive delete, history rewrites, " +
      "brain archive) raise a confirmation card before running.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command line to execute." }),
    }),
    async execute(_id: string, params: { command: string }, signal?: AbortSignal) {
      signal = signal && turn.signal ? AbortSignal.any([signal, turn.signal]) : signal ?? turn.signal ?? undefined;
      // The tool_call gate has already confirmed a destructive-pattern match
      // by now (and may have edited the command via updatedInput). The rtk
      // rewrite runs AFTER the gate, so confirm patterns see the command as
      // the model wrote it; when rtk is absent or declines, it is untouched.
      const childEnv: NodeJS.ProcessEnv = { ...subprocessEnv([...resolveEnabledWebSearchEnvNames(), ...WORKER_EGRESS_TRANSPORT_ENV]), ...RTK_WORKER_ENV };
      // A non-interactive bash sources the file BASH_ENV names (sh reads ENV),
      // here and in every shell the command starts (#2960).
      delete childEnv.BASH_ENV;
      delete childEnv.ENV;
      const cmd = await rtkRewriteCommand(params.command, childEnv);
      if (signal?.aborted) throw new DOMException("Tool cancelled before lock admission", "AbortError");
      // Only commands that touch git staging/history or the brain CLI's
      // write path take a lock (shared bashLockKey policy) — builds, greps,
      // curls and other reads run in parallel, across sessions and across
      // sibling tool calls in one message.
      return lock.withKey(bashLockKey(params.command), async () => {
        if (signal?.aborted) throw new DOMException("Tool cancelled before subprocess execution", "AbortError");
        if (turn.bridge?.commitToolAdmission) await turn.bridge.commitToolAdmission(_id, "bash", params);
        else {
          const stale = revalidatePiAdmission(turn, "bash", _id, params, true);
          if (stale) throw new Error(stale);
        }
        const exec = deps.exec ?? ambientExecConfig();
        // Not a login shell (#2960): `-l` sourced /etc/profile and the first
        // profile under HOME before every command, so their output reached
        // the result and anything they exported, PATH included, overrode the
        // allowlisted childEnv. --noprofile --norc reads no startup file; the
        // command sees exactly childEnv.
        const proc = spawn(wrapCommand(["bash", "--noprofile", "--norc", "-c", cmd], exec.wrapper), {
          cwd: deps.shellCwd ?? brain.root,
          env: childEnv,
          stdout: "pipe",
          stderr: "pipe",
          ...execWrapperSpawnOptions(exec.wrapper),
        });
        let killedByAbort = false;
        const onAbort = () => {
          killedByAbort = true;
          killWrapped(proc, exec);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        signal?.removeEventListener("abort", onAbort);
        const body = [stdout, stderr].filter(Boolean).join("\n").trim();
        // The exit line goes after the clip, so a long failing output still
        // ends with it: the host classifies a nonzero exit from it (#1671).
        const output = `${clip(body || "(no output)")}${code === 0 ? "" : `\n[exit ${code}]`}`;
        // Pi turns thrown tool errors into Activity-visible error results.
        // Keep the exit evidence, but distinguish a host abort from a command
        // that independently exited with the same status (including 143).
        if (killedByAbort) throw new DOMException(`Tool cancelled by abort\n${output}`, "AbortError");
        return textResult(output, { exitCode: code });
      });
    },
  } satisfies ToolDefinition;
}
