import { expect, test, spyOn } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerHostBoundary } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend.js";
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
    writeFileSync(join(state.path, project, "raft.jsonl"), "Odysseus transcript\n");
    writeFileSync(join(state.path, "settings.json"), "untrusted settings");
    state.persist();
    expect(readFileSync(join(saved, project, "raft.jsonl"), "utf8")).toBe("Odysseus transcript\n");
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
    writeFileSync(join(saved, project, "raft.jsonl"), "Concurrent transcript"); writeFileSync(join(state.path, project, "raft.jsonl"), "Worker transcript");
    expect(() => state.persist()).toThrow("changed concurrently");
    expect(readFileSync(join(saved, project, "raft.jsonl"), "utf8")).toBe("Concurrent transcript");
    expect(existsSync(join(saved, project, "alias.jsonl"))).toBe(false);
  } finally { state.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
