import { expect, test, spyOn } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareWorkerSandbox, workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend.js";
import { createWorkerSpawn } from "../src/worker-spawn.js";
import { createClaudeWorkerState } from "../src/worker-state.js";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";

test("a failed host probe refuses before the SDK query/spawn is called", async () => {
  let called = 0;
  const probe = spyOn(workerHostBoundary, "probe").mockReturnValue({ ok: false, requirement: "fixture capability missing" });
  try {
    const backend = createClaudeBackend({ brainPath: "/brain", queryFn: (() => { called++; throw new Error("spawn reached"); }) as never });
    await expect(backend.startTurn({ prompt: "Odysseus", signal: new AbortController().signal,
      bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } })).rejects.toThrow("fixture capability missing");
    expect(called, "runtime initialization must not be reached").toBe(0);
  } finally { probe.mockRestore(); }
});
test("Claude state snapshot cannot share an inode with the brain and only persists its transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-state-test-")); const brain = join(root, "brain"), saved = join(root, "config");
  mkdirSync(brain); mkdirSync(saved);
  let state: ReturnType<typeof createClaudeWorkerState> | undefined;
  try {
    writeFileSync(join(saved, "settings.json"), "{}");
    state = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved });
    const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
    mkdirSync(join(state.path, project), { recursive: true });
    writeFileSync(join(state.path, project, "11111111-1111-4111-8111-111111111111.jsonl"), "Odysseus transcript\n");
    writeFileSync(join(state.path, "settings.json"), "untrusted settings");
    state.persist();
    expect(readFileSync(join(saved, project, "11111111-1111-4111-8111-111111111111.jsonl"), "utf8")).toBe("Odysseus transcript\n");
    expect(readFileSync(join(saved, "settings.json"), "utf8")).toBe("{}");
    expect(workerCommand({ brainPath: brain, statePath: state.path, command: [process.execPath], env: {} })).toContain(state.path);
    expect(() => workerCommand({ brainPath: brain, statePath: saved, command: [process.execPath], env: {} })).toThrow("non-aliasing tmpfs");
  } finally { state?.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
test("state setup refuses a brain config path and a hardlink credential alias", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-state-alias-")), brain = join(root, "brain"), saved = join(root, "config");
  mkdirSync(brain); mkdirSync(saved); writeFileSync(join(brain, "policy.md"), "Athena policy");
  try {
    expect(() => createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: brain })).toThrow("outside");
    linkSync(join(brain, "policy.md"), join(saved, "settings.json"));
    expect(() => createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved })).toThrow("alias");
    expect(readFileSync(join(brain, "policy.md"), "utf8")).toBe("Athena policy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("worker transcript export refuses symlinks and concurrent saved-state overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-state-export-")), brain = join(root, "brain"), saved = join(root, "config"); mkdirSync(brain); mkdirSync(saved);
  const state = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved });
  const project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  try {
    mkdirSync(join(state.path, project), { recursive: true });
    writeFileSync(join(brain, "policy.md"), "Athena policy");
    symlinkSync(join(brain, "policy.md"), join(state.path, project, "alias.jsonl"));
    expect(() => state.persist()).toThrow(); expect(readFileSync(join(brain, "policy.md"), "utf8")).toBe("Athena policy");
    rmSync(join(state.path, project, "alias.jsonl"));
    mkdirSync(join(saved, project), { recursive: true });
    writeFileSync(join(saved, project, "11111111-1111-4111-8111-111111111111.jsonl"), "Concurrent transcript"); writeFileSync(join(state.path, project, "11111111-1111-4111-8111-111111111111.jsonl"), "Worker transcript");
    expect(() => state.persist()).toThrow("changed concurrently");
    expect(readFileSync(join(saved, project, "11111111-1111-4111-8111-111111111111.jsonl"), "utf8")).toBe("Concurrent transcript");
    expect(existsSync(join(saved, project, "alias.jsonl"))).toBe(false);
  } finally { state.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))("a real worker's linked turn-temp file is promoted and the saved answer links the copy (#1655)", async () => {
  const repo = resolve(import.meta.dir, "../../..");
  mkdirSync(join(repo, "tmp"), { recursive: true });
  const root = mkdtempSync(join(repo, "tmp/claude-promotion-")), brain = join(root, "brain"), saved = join(root, "config"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(saved); mkdirSync(home); writeFileSync(join(saved, "settings.json"), "{}");
  const turnId = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", session = "33333333-3333-4333-8333-333333333333";
  const project = `projects/${realpathSync(brain).replace(/[^a-zA-Z0-9]/g, "-")}`;
  const records: unknown[] = [];
  try {
    const sandbox = prepareWorkerSandbox(brain, { home });
    const spawner = createWorkerSpawn(brain, {}, new AbortController().signal, undefined, sandbox, undefined,
      { turnId, report: found => records.push(...found), log: () => {} });
    const program = `import * as fs from "node:fs";
      fs.writeFileSync(process.env.BRAIN_WORKER_SCRATCH + "/report.pdf", "Odysseus: the voyage report.");
      const dir = process.env.CLAUDE_CONFIG_DIR + "/${project}";
      fs.mkdirSync(dir, { recursive: true });
      const text = "The report: [voyage](/tmp/brain-worker-scratch/report.pdf).";
      fs.writeFileSync(dir + "/${session}.jsonl", JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n");`;
    const child = spawner.spawn({ command: process.execPath, args: ["-e", program], env: { CLAUDE_CONFIG_DIR: saved, HOME: home },
      signal: new AbortController().signal } as never);
    child.stdin.end();
    const code = await new Promise(done => child.once("exit", done));
    await spawner.finish();
    expect(code).toBe(0);
    const destination = `.brain/scratch/turns/${turnId}/report.pdf`;
    expect(readFileSync(join(brain, destination), "utf8")).toBe("Odysseus: the voyage report.");
    const transcript = JSON.parse(readFileSync(join(saved, project, `${session}.jsonl`), "utf8"));
    expect(transcript.message.content[0].text).toBe(`The report: [voyage](${destination}).`);
    expect(records).toEqual([{ kind: "promotion", source: "/tmp/brain-worker-scratch/report.pdf", destination, bytes: 28,
      originalLink: "/tmp/brain-worker-scratch/report.pdf", rewrittenLink: destination }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
