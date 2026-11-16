import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publishEvents } from "../scripts/ci-event-publish";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const repository = "odysseus/chronicle", ref = "refs/heads/brain-ci-metrics";
const event = (id = "event-1") => ({ version: 1, id, repository, kind: "work-started", at: "2026-07-12T00:00:00Z", worker: "worker-1", task: "task-1" });
function git(root: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode, new TextDecoder().decode(p.stderr)).toBe(0);
  return new TextDecoder().decode(p.stdout).trim();
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-events-")); dirs.push(root);
  const remote = join(root, "remote.git"); git(root, "init", "--bare", remote);
  const clones = ["one", "two"].map(name => {
    const clone = join(root, name); mkdirSync(clone); git(clone, "init"); git(clone, "remote", "add", "origin", remote);
    const dir = join(clone, "events"); mkdirSync(dir); return { root: clone, dir, repository };
  });
  return { root, remote, one: clones[0]!, two: clones[1]! };
}
function record(dir: string, value: object) { writeFileSync(join(dir, `event-${(value as { id: string }).id}.json`), JSON.stringify(value)); }

test("publishing the same batch twice adds nothing and conflicting IDs cannot rewrite history", async () => {
  const { one, remote } = setup(); record(one.dir, event());
  const first = await publishEvents(one);
  expect(first.added, "FIRST_BATCH_PUBLISHED").toBe(1);
  expect(await publishEvents(one)).toEqual({ added: 0, existing: 1, head: first.head });
  expect(JSON.parse(git(remote, "show", `${ref}:events/event-1.json`))).toEqual(event());
  record(one.dir, { ...event(), task: "task-2" });
  await expect(publishEvents(one)).rejects.toThrow("different content");
  expect(git(remote, "rev-parse", ref)).toBe(first.head!);
});

test("unsafe hostnames, outside paths and names are refused before any push", async () => {
  const { one, remote } = setup();
  for (const extra of [{ worker: "ithaca.example.invalid" }, { task: "/outside/crew" }, { orchestrator: "ithaca.example.invalid" }, { worker: "al" + "ain" }, { evidence: "/outside/crew" }]) {
    record(one.dir, { ...event(), ...extra });
    await expect(publishEvents(one), "UNSAFE_EVENT_REFUSED").rejects.toThrow();
    expect(git(remote, "for-each-ref", "--format=%(refname)"), "NOTHING_PUSHED").toBe("");
  }
});

test("two machines pushing concurrently both land their immutable events", async () => {
  const { root, one, two, remote } = setup(); record(one.dir, event("one")); record(two.dir, event("two"));
  const script = join(root, "contender.ts"), source = resolve(import.meta.dir, "../scripts/ci-event-publish.ts");
  // Both processes inspect the same missing remote before either may push.
  writeFileSync(script, `import {existsSync,writeFileSync} from "node:fs";
    import {publishEvents, GitEventStore} from ${JSON.stringify(source)};
    const [root,dir,id,barrier]=process.argv.slice(2);
    const store=new GitEventStore(root), read=store.read.bind(store); let first=true;
    store.read=async()=>{ const snapshot=await read(); if(first){first=false;writeFileSync(barrier+id,"ready");
      const deadline=Date.now()+10000;while(!existsSync(barrier+"1")||!existsSync(barrier+"2")){if(Date.now()>deadline)throw Error("barrier timeout");await Bun.sleep(5);}}
      return snapshot; };
    console.log(JSON.stringify(await publishEvents({root,dir,repository:${JSON.stringify(repository)},store})));`);
  const children = [one, two].map((options, i) => Bun.spawn([process.execPath, script, options.root, options.dir, String(i + 1), join(root, "barrier-")], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(0); return JSON.parse(out);
  }));
  expect(results.map(r => r.added)).toEqual([1, 1]);
  expect(git(remote, "ls-tree", "-r", "--name-only", ref).split("\n")).toEqual(["events/one.json", "events/two.json"]);
  expect(git(remote, "rev-list", "--count", ref)).toBe("2");
});

test("publication preserves unrelated monthly archive content and the caller index", async () => {
  const { one, remote } = setup();
  git(one.root, "config", "user.name", "Odysseus"); git(one.root, "config", "user.email", "odysseus@example.invalid");
  mkdirSync(join(one.root, "2026-07")); writeFileSync(join(one.root, "2026-07", "runs.json"), "[]\n");
  git(one.root, "add", "2026-07/runs.json"); git(one.root, "commit", "-m", "archive seed");
  git(one.root, "push", "origin", `HEAD:${ref}`);
  const parent = git(one.root, "rev-parse", "HEAD"), before = git(one.root, "ls-files", "--stage");
  record(one.dir, event()); const result = await publishEvents(one);
  expect(git(remote, "show", `${ref}:2026-07/runs.json`)).toBe("[]");
  expect(git(remote, "rev-parse", `${result.head}^`)).toBe(parent);
  expect(git(one.root, "ls-files", "--stage")).toBe(before);
  expect(git(one.root, "rev-parse", "HEAD")).toBe(parent);
});

test("an unsafe batch leaves another input directory usable and bounded batches retain local files", async () => {
  const { one, two, remote } = setup();
  record(one.dir, { ...event(), task: "/outside/crew" });
  await expect(publishEvents(one)).rejects.toThrow();
  record(two.dir, { ...event("safe"), kind: "preempted", orchestrator: "orchestrator-1", reason: "other" });
  expect((await publishEvents(two)).added).toBe(1);
  for (let i = 0; i < 101; i++) record(two.dir, event(`bounded-${i}`));
  const head = git(remote, "rev-parse", ref);
  await expect(publishEvents(two)).rejects.toThrow("batch exceeds 100");
  expect(git(remote, "rev-parse", ref)).toBe(head);
  expect(await Bun.file(join(two.dir, "event-bounded-100.json")).exists()).toBe(true);
});

test("the CLI records and publishes preemption and admission waits with stable IDs", async () => {
  const { one, remote } = setup(), script = resolve(import.meta.dir, "../scripts/ci-timings.ts");
  async function cli(...args: string[]) {
    const child = Bun.spawn([process.execPath, script, ...args, "--repo", repository, "--out", one.dir], { cwd: one.root, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(0); return out;
  }
  const input = join(one.root, "input.json");
  writeFileSync(input, JSON.stringify({ ...event("preempted-1"), kind: "preempted", orchestrator: "orchestrator-1" }));
  await cli("record", "--event", input);
  for (const kind of ["wait-started", "wait-finished"]) {
    writeFileSync(input, JSON.stringify({ ...event(kind), kind, task: "admission-slot-1", reason: "other" }));
    await cli("record", "--event", input);
  }
  expect(JSON.parse(await cli("publish"))).toMatchObject({ added: 3, existing: 0 });
  expect(JSON.parse(await cli("publish"))).toMatchObject({ added: 0, existing: 3 });
  expect(JSON.parse(git(remote, "show", `${ref}:events/preempted-1.json`)).orchestrator).toBe("orchestrator-1");
});

test("unknown versions, duplicate IDs and oversized records fail before remote publication", async () => {
  const { one, remote } = setup();
  record(one.dir, { ...event(), version: 2 });
  await expect(publishEvents(one)).rejects.toThrow("Invalid coordination event");
  record(one.dir, event()); writeFileSync(join(one.dir, "event-alias.json"), JSON.stringify(event()));
  await expect(publishEvents(one)).rejects.toThrow("Duplicate event ID");
  rmSync(join(one.dir, "event-alias.json"));
  writeFileSync(join(one.dir, "event-event-1.json"), " ".repeat(8193));
  await expect(publishEvents(one)).rejects.toThrow("size bounds");
  expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("");
});
