import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { WorkerStateLimits } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeWorkerState, rewriteAppendedAnswers, SessionTooLargeError, workerStateLimit } from "../src/worker-state.js";
import { createStateLedger, type StateLedger } from "../src/worker-state-budget.js";
import { resumedSessionId } from "../src/worker-spawn.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";
const MiB = 1024 * 1024;
const DEFAULT: WorkerStateLimits = { allowanceBytes: 64 * MiB, budgetBytes: 192 * MiB };
let root: string, brain: string, saved: string, project: string, ledger: StateLedger;
let roots = 0;
const states: ReturnType<typeof createClaudeWorkerState>[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "claude-scoped-state-"));
  brain = join(root, "brain"); saved = join(root, "config");
  project = `projects/${brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  fs.mkdirSync(brain); fs.mkdirSync(join(saved, project), { recursive: true });
  fs.writeFileSync(join(saved, "settings.json"), "{}");
  ledger = createStateLedger();
});
afterEach(() => { for (const state of states.splice(0)) state.release(); fs.rmSync(root, { recursive: true, force: true }); });
function state(resume?: string, limits: WorkerStateLimits = DEFAULT) {
  const result = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved }, { resume, limits, ledger });
  states.push(result); return result;
}
/** A fresh directory standing in for the worker's private tmpfs. */
function tmpfs(): string { const dir = join(root, `state-${roots++}`); fs.mkdirSync(dir); return dir; }
function populated(resume?: string, limits?: WorkerStateLimits) {
  const snapshot = state(resume, limits), path = tmpfs();
  snapshot.populate(path);
  return { snapshot, path };
}
function put(id: string, bytes: string) { fs.writeFileSync(join(saved, project, `${id}.jsonl`), bytes); }
function sparse(id: string, size: number) {
  const fd = fs.openSync(join(saved, project, `${id}.jsonl`), "w");
  try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
}
test("only a resumed session is copied, regardless of other large transcripts", () => {
  put(ID, "Odysseus\n"); sparse(OTHER, 339 * MiB);
  fs.mkdirSync(join(saved, project, ID)); fs.writeFileSync(join(saved, project, ID, "agent.jsonl"), "Athena\n");
  const { path } = populated(ID);
  expect(fs.readdirSync(join(path, project)).sort()).toEqual([ID, `${ID}.jsonl`]);
  expect(fs.readFileSync(join(path, project, ID, "agent.jsonl"), "utf8")).toBe("Athena\n");
});
test("a new session copies no transcripts", () => {
  sparse(OTHER, 339 * MiB);
  expect(fs.readdirSync(populated().path)).toEqual(["settings.json"]);
});
test("persist writes resumed and new sessions, leaving other sessions byte-identical", () => {
  put(ID, "Odysseus\n"); put(OTHER, "Penelope\n");
  const { snapshot, path } = populated(ID); const target = join(path, project);
  fs.writeFileSync(join(target, `${ID}.jsonl`), "Odysseus continued\n");
  fs.mkdirSync(join(target, OTHER)); fs.writeFileSync(join(target, OTHER, "new.jsonl"), "injection");
  fs.writeFileSync(join(target, `${NEW}.jsonl`), "Athena\n");
  fs.writeFileSync(join(target, "settings.json"), "not a transcript");
  snapshot.persist(path);
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
test("resume parsing reads the Agent SDK's single-token --resume=<id> form", () => {
  // The SDK builds `--resume=${id}` (sdk.mjs); a parser that only knows the
  // two-token form copies no transcript and the real CLI cannot resume.
  expect(resumedSessionId(["--output-format", "stream-json", `--resume=${ID}`, "--verbose"])).toBe(ID);
  expect(() => resumedSessionId(["--resume=../x"])).toThrow("UUID");
  expect(resumedSessionId(["--continue"])).toBeUndefined();
});
test("settings that cannot fit the allowance fail as worker_host_unsupported before any copy or reservation", () => {
  fs.writeFileSync(join(saved, "settings.json"), "x".repeat(8193));
  const write = spyOn(fs, "writeFileSync");
  try {
    let error: any; try { state(undefined, { allowanceBytes: 8192, budgetBytes: 8192 }); } catch (e) { error = e; }
    expect(error?.errorClass).toBe("worker_host_unsupported");
    expect(error.message).toContain("do not fit the worker's");
    expect(write).not.toHaveBeenCalled();
    expect(ledger.live).toBe(0);
  } finally { write.mockRestore(); }
});
test("a conversation that fills the allowance exactly is admitted; one page more is session_too_large before any copy", () => {
  // settings.json takes one page; the resumed transcript the rest.
  sparse(ID, 64 * MiB - 4096);
  expect(state(ID).bytes).toBe(64 * MiB);
  states.splice(0).forEach(s => s.release());
  sparse(ID, 64 * MiB - 4096 + 1);
  const write = spyOn(fs, "writeFileSync");
  try {
    let error: any; try { state(ID); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SessionTooLargeError); expect(error.errorClass).toBe("session_too_large");
    expect(error.message).toContain("64 MiB runtime-state allowance");
    expect(write).not.toHaveBeenCalled();
    expect(ledger.live, "a permanent refusal holds no reservation").toBe(0);
  } finally { write.mockRestore(); }
});
test("an overridden allowance drives the size check, the copy bound and the note", () => {
  sparse(ID, 3 * MiB);
  const small: WorkerStateLimits = { allowanceBytes: 2 * MiB, budgetBytes: 4 * MiB };
  let error: any; try { state(ID, small); } catch (e) { error = e; }
  expect(error?.errorClass).toBe("session_too_large");
  expect(error.message).toContain("2 MiB runtime-state allowance");
  const large: WorkerStateLimits = { allowanceBytes: 4 * MiB, budgetBytes: 8 * MiB };
  expect(state(ID, large).bytes).toBe(4 * MiB);
  expect(workerStateLimit(large)).toMatchObject({ name: "Runtime state", value: "4 MiB" });
  expect(workerStateLimit(DEFAULT)).toMatchObject({ name: "Runtime state", value: "64 MiB" });
});
test("a transcript that grew past the allowance after admission refuses during the copy", () => {
  put(ID, "Odysseus\n");
  const snapshot = state(ID, { allowanceBytes: 1 * MiB, budgetBytes: 1 * MiB });
  sparse(ID, 2 * MiB);
  expect(() => snapshot.populate(tmpfs())).toThrow("does not fit");
});
test("a full tmpfs during the copy is session_too_large, never raw ENOSPC", () => {
  put(ID, "Odysseus\n");
  const snapshot = state(ID);
  const write = spyOn(fs, "writeFileSync").mockImplementation(() => {
    throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
  });
  try {
    let error: any; try { snapshot.populate(tmpfs()); } catch (e) { error = e; }
    expect(error?.errorClass).toBe("session_too_large");
    expect(error?.code).not.toBe("ENOSPC");
  } finally { write.mockRestore(); }
});
test("concurrent saved transcript changes refuse overwrite", () => {
  put(ID, "initial"); const { snapshot, path } = populated(ID);
  put(ID, "concurrent"); fs.writeFileSync(join(path, project, `${ID}.jsonl`), "worker");
  expect(() => snapshot.persist(path)).toThrow("changed concurrently");
  expect(fs.readFileSync(join(saved, project, `${ID}.jsonl`), "utf8")).toBe("concurrent");
});
for (const alias of ["symlink", "hardlink"] as const) test(`resumed transcript refuses a ${alias}`, () => {
  put(OTHER, "Penelope");
  fs[alias === "symlink" ? "symlinkSync" : "linkSync"](join(saved, project, `${OTHER}.jsonl`), join(saved, project, `${ID}.jsonl`));
  expect(() => state(ID)).toThrow("alias");
  expect(ledger.live).toBe(0);
});
test("resumed session folder refuses a redirected directory", () => {
  fs.symlinkSync(brain, join(saved, project, ID));
  expect(() => state(ID)).toThrow("redirected");
});
for (const alias of ["symlink", "hardlink", "fifo"] as const) test(`persist refuses a worker-made ${alias} in its runtime state`, () => {
  const { snapshot, path } = populated();
  const target = join(path, project); fs.mkdirSync(target, { recursive: true });
  const outside = join(root, "outside.jsonl"); fs.writeFileSync(outside, "Scylla\n");
  if (alias === "symlink") fs.symlinkSync(outside, join(target, `${NEW}.jsonl`));
  else if (alias === "hardlink") fs.linkSync(outside, join(target, `${NEW}.jsonl`));
  else Bun.spawnSync(["mkfifo", join(target, `${NEW}.jsonl`)]);
  expect(() => snapshot.persist(path)).toThrow(/alias|special/);
  expect(fs.existsSync(join(saved, project, `${NEW}.jsonl`))).toBe(false);
});
test("persist refuses runtime output beyond the allowance", () => {
  const limits = { allowanceBytes: 1 * MiB, budgetBytes: 1 * MiB };
  const { snapshot, path } = populated(undefined, limits);
  const target = join(path, project); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(join(target, `${NEW}.jsonl`), Buffer.alloc(MiB / 2 + 1));
  fs.writeFileSync(join(target, `${ID}.jsonl`), Buffer.alloc(MiB / 2 + 1));
  expect(() => snapshot.persist(path)).toThrow("byte bound");
});
test("ephemeral state copies nothing in and never persists, but still reserves", () => {
  put(ID, "Odysseus");
  const snapshot = createClaudeWorkerState(brain, { CLAUDE_CONFIG_DIR: saved }, { ephemeral: true, limits: DEFAULT, ledger });
  states.push(snapshot);
  expect(ledger.held).toBe(64 * MiB);
  const path = tmpfs(); snapshot.populate(path); expect(fs.readdirSync(path)).toEqual([]);
  fs.mkdirSync(join(path, project), { recursive: true });
  fs.writeFileSync(join(path, project, `${NEW}.jsonl`), "Athena"); snapshot.persist(path);
  expect(fs.existsSync(join(saved, project, `${NEW}.jsonl`))).toBe(false);
});
test("persist rewrites only the answer text this run appended to a session's own transcript (#1655)", () => {
  const line = (type: string, text: string) => JSON.stringify({ type, message: { role: type, content: [{ type: "text", text }] } });
  const before = `${line("assistant", "Earlier: [map](/tmp/map.png)")}\n`;
  put(ID, before);
  fs.mkdirSync(join(saved, project, ID)); fs.writeFileSync(join(saved, project, ID, "agent.jsonl"), `${line("assistant", "[x](/tmp/x)")}\n`);
  const { snapshot, path } = populated(ID); const target = join(path, project);
  fs.appendFileSync(join(target, `${ID}.jsonl`), `${line("user", "[u](/tmp/u.txt)")}\n${line("assistant", "Now: [report](/tmp/report.pdf) and [map](/tmp/map.png)")}\n`);
  fs.appendFileSync(join(target, ID, "agent.jsonl"), `${line("assistant", "[y](/tmp/y)")}\n`);
  fs.writeFileSync(join(target, `${NEW}.jsonl`), `${line("assistant", "New: [report](/tmp/report.pdf)")}\n`);
  const seen: string[] = [];
  snapshot.persist(path, text => { seen.push(text); return text.replaceAll("/tmp/", ".brain/scratch/turns/t/"); });
  expect(seen.sort()).toEqual(["New: [report](/tmp/report.pdf)", "Now: [report](/tmp/report.pdf) and [map](/tmp/map.png)"]);
  const out = fs.readFileSync(join(saved, project, `${ID}.jsonl`), "utf8");
  expect(out.startsWith(before)).toBe(true);
  expect(out.slice(before.length)).toBe(`${line("user", "[u](/tmp/u.txt)")}\n${line("assistant", "Now: [report](.brain/scratch/turns/t/report.pdf) and [map](.brain/scratch/turns/t/map.png)")}\n`);
  expect(fs.readFileSync(join(saved, project, ID, "agent.jsonl"), "utf8")).toBe(`${line("assistant", "[x](/tmp/x)")}\n${line("assistant", "[y](/tmp/y)")}\n`);
  expect(fs.readFileSync(join(saved, project, `${NEW}.jsonl`), "utf8")).toBe(`${line("assistant", "New: [report](.brain/scratch/turns/t/report.pdf)")}\n`);
});
test("a transcript whose saved prefix changed is not rewritten", () => {
  const record = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const before = Buffer.from(`${record("a")}\n`);
  const changed = Buffer.from(`${record("b")}\n${record("c")}\n`);
  const prefix = { length: before.length, hash: createHash("sha256").update(before).digest("hex") };
  expect(rewriteAppendedAnswers(changed, prefix, () => "rewritten")).toBe(changed);
  expect(rewriteAppendedAnswers(Buffer.concat([before, Buffer.from(`${record("c")}\n`)]), prefix, () => "rewritten").toString())
    .toBe(`${record("a")}\n${record("rewritten")}\n`);
});
