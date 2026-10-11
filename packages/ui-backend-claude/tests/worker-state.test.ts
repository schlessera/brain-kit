import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClaudeWorkerState, MAX_STATE_BYTES, stateReserveBytes, SessionTooLargeError } from "../src/worker-state.js";
import { resumedSessionId } from "../src/worker-spawn.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";
let root: string, brain: string, saved: string, project: string, stateRoot: string;
const states: ReturnType<typeof createClaudeWorkerState>[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "claude-scoped-state-"));
  brain = join(root, "brain"); saved = join(root, "config"); stateRoot = join(root, "state");
  project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  fs.mkdirSync(brain); fs.mkdirSync(stateRoot); fs.mkdirSync(join(saved, project), { recursive: true });
  fs.writeFileSync(join(saved, "settings.json"), "{}");
});
afterEach(() => { for (const state of states.splice(0)) state.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
function state(resume?: string, freeBytes = Number.MAX_SAFE_INTEGER) {
  const result = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved }, { resume, stateRoot, freeBytes: () => freeBytes });
  states.push(result); return result;
}
function put(id: string, bytes: string) { fs.writeFileSync(join(saved, project, `${id}.jsonl`), bytes); }
function sparse(id: string, size: number) {
  const fd = fs.openSync(join(saved, project, `${id}.jsonl`), "w");
  try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
}
test("only a resumed session is copied, regardless of other large transcripts", () => {
  put(ID, "Odysseus\n"); sparse(OTHER, 339 * 1024 * 1024);
  fs.mkdirSync(join(saved, project, ID)); fs.writeFileSync(join(saved, project, ID, "agent.jsonl"), "Athena\n");
  const snapshot = state(ID, 64 * 1024 * 1024);
  expect(fs.readdirSync(join(snapshot.path, project)).sort()).toEqual([ID, `${ID}.jsonl`]);
  expect(fs.readFileSync(join(snapshot.path, project, ID, "agent.jsonl"), "utf8")).toBe("Athena\n");
});
test("a new session copies no transcripts", () => {
  sparse(OTHER, 339 * 1024 * 1024);
  expect(fs.readdirSync(state().path)).toEqual(["settings.json"]);
});
test("persist writes resumed and new sessions, leaving other sessions byte-identical", () => {
  put(ID, "Odysseus\n"); put(OTHER, "Penelope\n");
  const snapshot = state(ID); const target = join(snapshot.path, project);
  fs.writeFileSync(join(target, `${ID}.jsonl`), "Odysseus continued\n");
  fs.mkdirSync(join(target, OTHER)); fs.writeFileSync(join(target, OTHER, "new.jsonl"), "injection");
  fs.writeFileSync(join(target, `${NEW}.jsonl`), "Athena\n");
  fs.writeFileSync(join(target, "settings.json"), "not a transcript");
  snapshot.persist();
  expect(fs.readFileSync(join(saved, project, `${ID}.jsonl`), "utf8")).toBe("Odysseus continued\n");
  expect(fs.readFileSync(join(saved, project, `${OTHER}.jsonl`), "utf8")).toBe("Penelope\n");
  expect(fs.existsSync(join(saved, project, OTHER))).toBe(false);
  expect(fs.readFileSync(join(saved, project, `${NEW}.jsonl`), "utf8")).toBe("Athena\n");
  expect(fs.existsSync(join(saved, project, "settings.json"))).toBe(false);
});
test("resume parsing refuses a path and a missing id", () => {
  expect(() => state("../x")).toThrow("UUID");
  expect(() => resumedSessionId(["--resume", "../x"])).toThrow("UUID");
  expect(() => resumedSessionId(["--resume"])).toThrow("UUID");
  expect(resumedSessionId(["--resume", ID])).toBe(ID);
});
test("settings that cannot fit fail as worker_host_unsupported before any copy", () => {
  const write = spyOn(fs, "writeFileSync");
  try {
    let error: any; try { state(undefined, 1); } catch (e) { error = e; }
    expect(error?.errorClass).toBe("worker_host_unsupported");
    expect(error.message).toContain("settings and credentials do not fit");
    expect(error.code).not.toBe("ENOSPC"); expect(write).not.toHaveBeenCalled();
  } finally { write.mockRestore(); }
});
for (const cause of ["byte bound", "free space"] as const) test(`oversized session (${cause}) fails before any copy`, () => {
  if (cause === "byte bound") sparse(ID, MAX_STATE_BYTES + 1); else sparse(ID, 1024 * 1024);
  const write = spyOn(fs, "writeFileSync");
  try {
    let error: any; try { state(ID, cause === "free space" ? 16 * 1024 * 1024 + 3 : Number.MAX_SAFE_INTEGER); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SessionTooLargeError); expect(error.errorClass).toBe("session_too_large");
    expect(write).not.toHaveBeenCalled();
  } finally { write.mockRestore(); }
});
test("concurrent saved transcript changes refuse overwrite", () => {
  put(ID, "initial"); const snapshot = state(ID);
  put(ID, "concurrent"); fs.writeFileSync(join(snapshot.path, project, `${ID}.jsonl`), "worker");
  expect(() => snapshot.persist()).toThrow("changed concurrently");
  expect(fs.readFileSync(join(saved, project, `${ID}.jsonl`), "utf8")).toBe("concurrent");
});
for (const alias of ["symlink", "hardlink"] as const) test(`resumed transcript refuses a ${alias}`, () => {
  put(OTHER, "Penelope");
  fs[alias === "symlink" ? "symlinkSync" : "linkSync"](join(saved, project, `${OTHER}.jsonl`), join(saved, project, `${ID}.jsonl`));
  expect(() => state(ID)).toThrow("alias");
});
test("resumed session folder refuses a redirected directory", () => {
  fs.symlinkSync(brain, join(saved, project, ID));
  expect(() => state(ID)).toThrow("redirected");
});
test("ephemeral state remains empty and never persists", () => {
  put(ID, "Odysseus");
  const snapshot = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved }, { ephemeral: true, stateRoot, freeBytes: () => 0 });
  states.push(snapshot); expect(fs.readdirSync(snapshot.path)).toEqual([]);
  fs.mkdirSync(join(snapshot.path, project), { recursive: true });
  fs.writeFileSync(join(snapshot.path, project, `${NEW}.jsonl`), "Athena"); snapshot.persist();
  expect(fs.existsSync(join(saved, project, `${NEW}.jsonl`))).toBe(false);
});

test("a free-space race is a named host error, never raw ENOSPC", () => {
  const write = spyOn(fs, "writeFileSync").mockImplementation(() => {
    throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
  });
  try {
    let error: any; try { state(); } catch (e) { error = e; }
    expect(error?.errorClass).toBe("worker_host_unsupported");
    expect(error?.code).not.toBe("ENOSPC");
  } finally { write.mockRestore(); }
});

const MiB = 1024 * 1024;
test("state reserve has a 16 MiB floor and scales to 25 percent", () => {
  expect(stateReserveBytes(0)).toBe(16 * MiB);
  expect(stateReserveBytes(80 * MiB)).toBe(20 * MiB);
});
for (const capacity of [64 * MiB, MAX_STATE_BYTES + MiB]) {
  test(`session copy fits but growth reserve does not (${capacity})`, () => {
    sparse(ID, capacity === 64 * MiB ? 50 * MiB : 104 * MiB);
    const write = spyOn(fs, "writeFileSync");
    try {
      let error: any; try { state(ID, capacity); } catch (e) { error = e; }
      expect(error?.errorClass).toBe("session_too_large");
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
}
test("settings copy fits but its minimum reserve does not", () => {
  let error: any; try { state(undefined, 16 * MiB + 1); } catch (e) { error = e; }
  expect(error?.errorClass).toBe("worker_host_unsupported");
  expect(fs.readdirSync(state(undefined, 16 * MiB + 2).path)).toEqual(["settings.json"]);
});
