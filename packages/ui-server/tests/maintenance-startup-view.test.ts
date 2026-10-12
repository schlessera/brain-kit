import * as fs from "node:fs";
import { afterEach, expect, test, spyOn } from "bun:test";
import { chmodSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerSdk from "@schlessera/brain-ui-sdk/internal";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { hostProcessAlive, waitForHostProcesses } from "./helpers/host-processes";
import { createTestApp } from "./helpers/test-app";
import { prepareMaintenanceOutput } from "../src/brain/maintenance-output.js";
import { listDirectory } from "../src/files/walker.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { createHostExecution } from "../src/brain/host-execution.js";
import { createUiDb } from "../src/db/client.js";
import { processStateLedger } from "../../ui-sdk/src/server/worker-state-budget.js";
import { prepareWorkerSandbox, workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });
function fixture() {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-maintenance-"));
  cleanup.push(() => rmSync(brain, { recursive: true, force: true }));
  writeFileSync(join(brain, "brain.config.ts"), 'import value from "./helper.ts"; export default value;');
  writeFileSync(join(brain, "helper.ts"), 'export default "before launch";');
  writeFileSync(join(brain, "harbor.md"), "Odysseus before launch.\n");
  return brain;
}

test("hostile output permissions release the real writer gate and all staging storage", async () => {
  const brain = fixture();
  const state = mkdtempSync("/var/tmp/odysseus-cleanup-state-");
  cleanup.push(() => rmSync(state, { recursive: true, force: true }));
  const dbPath = join(state, "ui.db");
  const db = createUiDb(dbPath);
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} });
  execution.attach(db);
  const heldBefore = processStateLedger().outputStagingHeld;
  try {
    const program = 'import{mkdirSync,chmodSync}from"node:fs";const root=process.env.BRAIN_ROOT;mkdirSync(root+"/locked");mkdirSync(root+"/locked/nested");chmodSync(root+"/locked/nested",0);chmodSync(root+"/locked",0);console.log("HOSTILE_OUTPUT_CREATED");';
    const worker = await execution.boundary.launch({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program], env: {},
      credentials: false, gate: "exclusive", purpose: "hostile output cleanup" });
    const streams = Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    await expect(worker.exited).rejects.toThrow("EACCES");
    expect((await streams)[0], "HOSTILE_OUTPUT_WORKER_RAN").toBe("HOSTILE_OUTPUT_CREATED\n");
    expect(readFileSync(join(brain, "harbor.md"), "utf8")).toBe("Odysseus before launch.\n");
    expect(existsSync(join(brain, "locked")), "REFUSED_OUTPUT_NOT_PUBLISHED").toBe(false);
    expect(processStateLedger().outputStagingHeld, "HOSTILE_OUTPUT_STORAGE_RELEASED").toBe(heldBefore);
    const next = await execution.gate()!.acquire("exclusive", "after hostile output", { signal: AbortSignal.timeout(1000) });
    next.release();
    const reader = await execution.boundary.run({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", 'console.log("READMITTED")'],
      env: {}, credentials: false, gate: "shared", purpose: "readmission after refused output" });
    expect(reader.exitCode, reader.stderr).toBe(0);
    expect(reader.stdout).toBe("READMITTED\n");
    expect(processStateLedger().outputStagingHeld).toBe(heldBefore);
  } finally { db.close(); }
});

test("failed launch cleans read-only copies without changing the live brain mode", async () => {
  const brain = fixture();
  const state = mkdtempSync("/var/tmp/odysseus-failed-start-");
  cleanup.push(() => rmSync(state, { recursive: true, force: true }));
  const dbPath = join(state, "ui.db");
  const db = createUiDb(dbPath);
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: { wrapper: join(state, "absent-wrapper") } });
  execution.attach(db);
  expect(execution.boundary.isolated(), "FAILED_START_REAL_BOUNDARY_PROVEN").toBe(true);
  chmodSync(brain, 0o555); cleanup.push(() => chmodSync(brain, 0o700));
  const heldBefore = processStateLedger().outputStagingHeld;
  try {
    await expect(execution.boundary.launch({ argv: [process.execPath, "--version"], env: {}, credentials: false,
      gate: "exclusive", purpose: "failed read-only-copy launch" }), "FAILED_START_ORIGINAL_ERROR").rejects.toThrow("does not exist");
    expect(processStateLedger().outputStagingHeld, "FAILED_START_STORAGE_RELEASED").toBe(heldBefore);
    expect(statSync(brain).mode & 0o777, "LIVE_DIRECTORY_MODE_UNCHANGED").toBe(0o555);
    const next = await execution.gate()!.acquire("exclusive", "after failed start", { signal: AbortSignal.timeout(1000) });
    next.release();
  } finally { db.close(); }
});

test("nested read-only directory modes are finalized after their children", () => {
  const brain = fixture();
  const outputs = prepareMaintenanceOutput(brain); cleanup.push(outputs.cleanup);
  mkdirSync(join(outputs.output.source, "voyage/harbor"), { recursive: true });
  writeFileSync(join(outputs.output.source, "voyage/harbor/departure.md"), "Odysseus departs.\n");
  chmodSync(join(outputs.output.source, "voyage/harbor"), 0o555);
  chmodSync(join(outputs.output.source, "voyage"), 0o555);
  cleanup.push(() => { for (const dir of ["voyage", "voyage/harbor"]) if (existsSync(join(brain, dir))) chmodSync(join(brain, dir), 0o700); });
  expect(() => outputs.publish(), "READ_ONLY_DIRECTORY_CHILDREN_PUBLISHED").not.toThrow();
  expect(readFileSync(join(brain, "voyage/harbor/departure.md"), "utf8"), "READ_ONLY_DIRECTORY_CHILD_PUBLISHED").toBe("Odysseus departs.\n");
  expect(statSync(join(brain, "voyage")).mode & 0o777).toBe(0o555);
  expect(statSync(join(brain, "voyage/harbor")).mode & 0o777).toBe(0o555);
});

test("directory finalization preserves a governed peer's mode and still finalizes other directories", () => {
  const brain = fixture();
  for (const dir of ["loom", "voyage"]) mkdirSync(join(brain, dir));
  const outputs = prepareMaintenanceOutput(brain); cleanup.push(outputs.cleanup);
  for (const dir of ["loom", "voyage"]) chmodSync(join(outputs.output.source, dir), 0o555);
  // Populate the readable copy before making its parent read-only.
  chmodSync(join(outputs.output.source, "voyage"), 0o755);
  writeFileSync(join(outputs.output.source, "voyage/harbor.md"), "Odysseus departs.\n");
  chmodSync(join(outputs.output.source, "voyage"), 0o555);
  const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
  expect(sandbox.profile, sandbox.fallbackReason).toBe("governed");
  const original = fs.writeSync;
  let altered = false;
  const write = spyOn(fs, "writeSync").mockImplementation((...args: any[]) => {
    if (!altered && fs.readlinkSync(`/proc/self/fd/${args[0]}`).includes("/.maintenance-")) {
      const peer = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, env: { PATH: "/usr/bin:/bin" },
        command: ["/bin/sh", "-c", 'chmod 777 voyage && printf "PEER_MODE_CHANGED"'] }), { env: {}, stdout: "pipe", stderr: "pipe" });
      expect(peer.exitCode, peer.stderr.toString()).toBe(0);
      expect(peer.stdout.toString()).toBe("PEER_MODE_CHANGED");
      expect(statSync(join(brain, "voyage")).mode & 0o777).toBe(0o777);
      altered = true;
    }
    return (original as (...input: any[]) => number)(...args);
  });
  cleanup.push(() => { for (const dir of ["loom", "voyage"]) chmodSync(join(brain, dir), 0o700); });
  try {
    expect(() => outputs.publish(), "DIRECTORY_MODE_REVALIDATED_AT_COMMIT").toThrow("stale maintenance output");
    expect(altered, "GOVERNED_MODE_PEER_RAN").toBe(true);
    expect(statSync(join(brain, "voyage")).mode & 0o777, "PEER_DIRECTORY_MODE_PRESERVED").toBe(0o777);
    expect(statSync(join(brain, "loom")).mode & 0o777, "OTHER_DIRECTORY_FINALIZED_AFTER_REFUSAL").toBe(0o555);
  } finally { write.mockRestore(); }
});

test("an injected final chmod error does not leave other directories in temporary modes", () => {
  const brain = fixture();
  for (const dir of ["loom", "voyage"]) mkdirSync(join(brain, dir));
  const outputs = prepareMaintenanceOutput(brain); cleanup.push(outputs.cleanup);
  for (const dir of ["loom", "voyage"]) chmodSync(join(outputs.output.source, dir), 0o555);
  const original = fs.fchmodSync;
  let injected = false;
  let failedDirectory = "";
  const chmod = spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
    const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (!injected && mode === 0o555 && [join(brain, "loom"), join(brain, "voyage")].includes(path)) {
      injected = true;
      failedDirectory = path;
      throw Object.assign(new Error("fixture final chmod EIO"), { code: "EIO" });
    }
    return original(fd, mode);
  });
  cleanup.push(() => { for (const dir of ["loom", "voyage"]) chmodSync(join(brain, dir), 0o700); });
  try {
    expect(() => outputs.publish()).toThrow("fixture final chmod EIO");
    expect(injected).toBe(true);
    const other = [join(brain, "loom"), join(brain, "voyage")].find(path => path !== failedDirectory)!;
    expect(statSync(other).mode & 0o777, "OTHER_DIRECTORY_FINALIZED_AFTER_CHMOD_ERROR").toBe(0o555);
  } finally { chmod.mockRestore(); }
});
test("maintenance publishes explicit output without opening the execution view for writes", async () => {
  const brain = fixture();
  const boundary = createHostBoundary({ brainPath: brain });
  expect(boundary.isolated()).toBe(true);
  const program = 'console.log((await import("./brain.config.ts")).default); try {await Bun.write("./harbor.md", "attack"); process.exit(43)} catch(e) {if(e.code!=="EROFS")throw e} await Bun.write(process.env.BRAIN_ROOT + "/harbor.md", "Odysseus departs.\\n");';
  const result = await boundary.run({ argv: [process.execPath, "--no-env-file", "-e", program], env: {}, credentials: false, gate: "shared", purpose: "maintenance output proof" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("before launch");
  expect(readFileSync(join(brain, "harbor.md"), "utf8")).toBe("Odysseus departs.\n");
});
test("an already-running maintenance reader retains dependency bytes and absence", async () => {
  const brain = fixture();
  const control = mkdtempSync("/var/tmp/odysseus-control-"); cleanup.push(() => rmSync(control, { recursive: true, force: true }));
  const go = join(control, "go");
  const boundary = createHostBoundary({ brainPath: brain });
  const program = `console.log("ready"); while(!await Bun.file(${JSON.stringify(go)}).exists()) await Bun.sleep(5); console.log((await import("./brain.config.ts")).default); console.log(await Bun.file(".mcp.json").exists());`;
  const worker = await boundary.launch({ argv: [process.execPath, "--no-env-file", "-e", program], env: {}, credentials: false, gate: "shared", purpose: "maintenance overlap proof" });
  const stream = worker.stdout.getReader();
  try {
    expect(Buffer.from((await stream.read()).value ?? []).toString()).toBe("ready\n");
    writeFileSync(join(brain, "helper.ts"), 'export default "during launch";');
    writeFileSync(join(brain, ".mcp.json"), "{}");
    writeFileSync(go, "go");
    let output = "";
    for (;;) { const next = await stream.read(); if (next.done) break; output += Buffer.from(next.value).toString(); }
    expect(await worker.exited, await new Response(worker.stderr).text()).toBe(0);
    expect(output).toBe("before launch\nfalse\n");
    expect(readFileSync(join(brain, "helper.ts"), "utf8")).toContain("during launch");
  } finally { worker.kill("SIGKILL"); }
});
test("stale outputs and policy edits are refused before any publication", () => {
  const brain = fixture();
  const outputs = prepareMaintenanceOutput(brain); cleanup.push(outputs.cleanup);
  writeFileSync(join(outputs.output.source, "harbor.md"), "Odysseus from maintenance.\n");
  writeFileSync(join(brain, "harbor.md"), "Penelope from a peer.\n");
  expect(() => outputs.publish()).toThrow("stale maintenance output");
  expect(readFileSync(join(brain, "harbor.md"), "utf8")).toBe("Penelope from a peer.\n");
  const other = prepareMaintenanceOutput(brain); cleanup.push(other.cleanup);
  mkdirSync(join(other.output.source, "context/policies"), { recursive: true });
  writeFileSync(join(other.output.source, "context/policies/governance.md"), "attack");
  writeFileSync(join(other.output.source, "harbor.md"), "attack");
  expect(() => other.publish()).toThrow("protected input");
  expect(existsSync(join(brain, "context"))).toBe(false);
});
test("an output symlink cannot redirect the host writer", () => {
  const brain = fixture();
  const outputs = prepareMaintenanceOutput(brain); cleanup.push(outputs.cleanup);
  symlinkSync("/etc/passwd", join(outputs.output.source, "harbor-link.md"));
  expect(() => outputs.publish()).toThrow("escaping link");
  expect(existsSync(join(brain, "harbor-link.md"))).toBe(false);
});

test("a refused directory replacement preserves every existing child", () => {
  const brain = fixture();
  mkdirSync(join(brain, "notes"));
  writeFileSync(join(brain, "notes/loom.md"), "Penelope's original.\n");
  const outputs = prepareMaintenanceOutput(brain); cleanup.push(outputs.cleanup);
  rmSync(join(outputs.output.source, "notes"), { recursive: true });
  writeFileSync(join(outputs.output.source, "notes"), "Odysseus replaces the directory.\n");
  expect(() => outputs.publish()).toThrow();
  expect(readFileSync(join(brain, "notes/loom.md"), "utf8")).toBe("Penelope's original.\n");
});

test("a host file-list reader freezes ignore configuration before its first await", async () => {
  const brain = fixture();
  writeFileSync(join(brain, "loom.md"), "Penelope.\n");
  writeFileSync(join(brain, ".gitignore"), "loom.md\n");
  const pending = listDirectory("", brain);
  writeFileSync(join(brain, ".gitignore"), "harbor.md\n");
  const entries = await pending;
  expect(entries.map(entry => entry.name)).toContain("harbor.md");
  expect(entries.map(entry => entry.name)).not.toContain("loom.md");
  expect((await listDirectory("", brain)).map(entry => entry.name)).toContain("loom.md");
});

test("maintenance Git freezes filter dependencies and attributes while publishing its index", async () => {
  const brain = fixture();
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: brain, stdout: "pipe", stderr: "pipe" });
  expect(git("init", "-q").exitCode).toBe(0);
  expect(git("config", "filter.crew.clean", "sh filters/clean.sh").exitCode).toBe(0);
  mkdirSync(join(brain, "filters"));
  writeFileSync(join(brain, "filters/clean.sh"), "cat filters/value.txt; cat\n");
  writeFileSync(join(brain, "filters/value.txt"), "before launch\n");
  writeFileSync(join(brain, ".gitattributes"), "*.md filter=crew\n");
  const control = mkdtempSync("/var/tmp/odysseus-git-control-"); cleanup.push(() => rmSync(control, { recursive: true, force: true }));
  const go = join(control, "go");
  const boundary = createHostBoundary({ brainPath: brain });
  const program = `console.log("ready"); while(!await Bun.file(${JSON.stringify(go)}).exists()) await Bun.sleep(5);
    await Bun.write(process.env.BRAIN_ROOT+"/raft.md", "Odysseus builds a raft.\\n");
    for(const args of [["add","raft.md"],["show",":raft.md"]]) {const p=Bun.spawnSync(["git",...args],{stdout:"pipe",stderr:"pipe"});if(p.exitCode)throw new Error(p.stderr.toString()); if(args[0]==="show")process.stdout.write(p.stdout);}`;
  const worker = await boundary.launch({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program], env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "shared", purpose: "Git startup proof" });
  const reader = worker.stdout.getReader();
  try {
    expect(Buffer.from((await reader.read()).value ?? []).toString()).toBe("ready\n");
    writeFileSync(join(brain, "filters/value.txt"), "during launch\n");
    writeFileSync(join(brain, ".gitattributes"), "*.md -filter\n");
    writeFileSync(go, "go");
    let output = "";
    for (;;) { const next = await reader.read(); if (next.done) break; output += Buffer.from(next.value).toString(); }
    expect(await worker.exited, await new Response(worker.stderr).text()).toBe(0);
    expect(output, "GIT_CONFIGURATION_STARTUP_ONLY").toBe("before launch\nOdysseus builds a raft.\n");
    expect(git("show", ":raft.md").stdout.toString()).toBe(output);
    expect(readFileSync(join(brain, "filters/value.txt"), "utf8")).toBe("during launch\n");
  } finally { worker.kill("SIGKILL"); }
});

test("deleting a directory refuses changed membership before deleting its original children", () => {
  const brain = fixture();
  mkdirSync(join(brain, "notes"));
  writeFileSync(join(brain, "notes/loom.md"), "Penelope's original.\n");
  const outputs = prepareMaintenanceOutput(brain); cleanup.push(outputs.cleanup);
  rmSync(join(outputs.output.source, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/peer.md"), "Odysseus from the peer.\n");
  expect(() => outputs.publish()).toThrow("stale maintenance output");
  expect(readFileSync(join(brain, "notes/loom.md"), "utf8")).toBe("Penelope's original.\n");
  expect(readFileSync(join(brain, "notes/peer.md"), "utf8")).toBe("Odysseus from the peer.\n");
});


test("maintenance publication retains a directory permission change", () => {
  const brain = fixture();
  mkdirSync(join(brain, "notes/private"), { recursive: true, mode: 0o755 });
  const outputs = prepareMaintenanceOutput(brain);
  try {
    chmodSync(join(outputs.output.source, "notes/private"), 0o700);
    outputs.publish();
    expect(statSync(join(brain, "notes/private")).mode & 0o777, "OUTPUT_DIRECTORY_MODE_PUBLISHED").toBe(0o700);
  } finally { outputs.cleanup(); }
});

for (const kind of ["existing file", "new file", "new directory"] as const) test(`publication preserves ${kind} permissions despite the server umask`, () => {
  const brain = fixture();
  const destination = join(brain, "shared");
  if (kind === "existing file") { writeFileSync(destination, "before"); chmodSync(destination, 0o666); }
  const outputs = prepareMaintenanceOutput(brain);
  const savedUmask = process.umask(0o022);
  try {
    const staged = join(outputs.output.source, "shared");
    if (kind === "new directory") mkdirSync(staged);
    else writeFileSync(staged, "Odysseus and Penelope share the output.\n");
    const wanted = kind === "new directory" ? 0o777 : 0o666;
    chmodSync(staged, wanted);
    outputs.publish();
    expect(statSync(destination).mode & 0o777, "OUTPUT_MODE_SURVIVES_SERVER_UMASK").toBe(wanted);
  } finally { process.umask(savedUmask); outputs.cleanup(); }
});


for (const existing of [true, false]) test(`publication refuses a peer write during copy (${existing ? "existing" : "new"} file)`, () => {
  const brain = fixture();
  const destination = join(brain, "shared.md");
  if (existing) writeFileSync(destination, "before");
  const outputs = prepareMaintenanceOutput(brain);
  writeFileSync(join(outputs.output.source, "shared.md"), "Odysseus stages new content.");
  const original = fs.writeSync;
  let altered = false;
  const write = spyOn(fs, "writeSync").mockImplementation((...args: any[]) => {
    if (!altered && fs.readlinkSync(`/proc/self/fd/${args[0]}`).includes("/.maintenance-")) {
      altered = true;
      writeFileSync(destination, "Penelope's newer content");
    }
    return (original as (...input: any[]) => number)(...args);
  });
  try {
    expect(() => outputs.publish(), "PUBLICATION_REVALIDATES_AT_COMMIT").toThrow("stale maintenance output");
    expect(altered).toBe(true);
    expect(readFileSync(destination, "utf8"), "PEER_WRITE_SURVIVES_PUBLICATION").toBe("Penelope's newer content");
  } finally { write.mockRestore(); outputs.cleanup(); }
});


test("publication installs a newly absent file without clobbering a last-moment creator", () => {
  const brain = fixture(); const destination = join(brain, "shared.md");
  const outputs = prepareMaintenanceOutput(brain);
  writeFileSync(join(outputs.output.source, "shared.md"), "Odysseus stages new content.");
  const linkOriginal = fs.linkSync, renameOriginal = fs.renameSync;
  const createPeer = () => writeFileSync(destination, "Penelope wins creation");
  const link = spyOn(fs, "linkSync").mockImplementation((from, to) => { createPeer(); return linkOriginal(from, to); });
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => { createPeer(); return renameOriginal(from, to); });
  try {
    expect(() => outputs.publish(), "PUBLICATION_ATOMIC_NO_CLOBBER").toThrow("stale maintenance output");
    expect(readFileSync(destination, "utf8")).toBe("Penelope wins creation");
  } finally { link.mockRestore(); rename.mockRestore(); outputs.cleanup(); }
});

for (const moved of [false, true]) test(`finalizing a child with parent search removed preserves ${moved ? "a moved inode" : "its final mode"}`, () => {
  const brain = fixture();
  const outputs = prepareMaintenanceOutput(brain); cleanup.push(outputs.cleanup);
  mkdirSync(join(outputs.output.source, "voyage/harbor"), { recursive: true });
  writeFileSync(join(outputs.output.source, "voyage/harbor/note.md"), "Odysseus departs.\n");
  for (const rel of ["voyage/harbor", "voyage"]) chmodSync(join(outputs.output.source, rel), 0o555);
  cleanup.push(() => { for (const rel of ["voyage", "voyage/harbor", "voyage/moved"]) if (existsSync(join(brain, rel))) chmodSync(join(brain, rel), 0o700); });
  const original = fs.writeSync; let changed = false;
  const intercept = spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
    if (!changed && fs.readlinkSync(`/proc/self/fd/${args[0]}`).includes("/.maintenance-")) {
      changed = true;
      const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
      const peer = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, env: {},
        command: ["/bin/sh", "-c", moved ? 'mv "$1/harbor" "$1/moved"; mkdir "$1/harbor"; chmod 000 "$1"' : 'chmod 000 "$1"', "peer", join(brain, "voyage")] }), { stdout: "pipe", stderr: "pipe", env: {} });
      expect(peer.exitCode, peer.stderr.toString()).toBe(0);
    }
    return original(...args);
  }) as typeof fs.writeSync);
  try { expect(() => outputs.publish()).toThrow(); }
  finally { intercept.mockRestore(); }
  expect(changed, "PEER_REMOVED_PARENT_SEARCH").toBe(true);
  expect(statSync(join(brain, "voyage")).mode & 0o777, "PEER_PARENT_MODE_RETAINED").toBe(0);
  chmodSync(join(brain, "voyage"), 0o700);
  if (moved) expect(statSync(join(brain, "voyage/moved")).mode & 0o777, "MOVED_CHILD_MODE_NOT_OVERWRITTEN").toBe(0o755);
  else expect(statSync(join(brain, "voyage/harbor")).mode & 0o777, "UNAFFECTED_CHILD_FINAL_MODE").toBe(0o555);
});


test("separate maintenance clients serialize frozen preparation through publication", async () => {
  const brain = fixture(), control = mkdtempSync("/var/tmp/odysseus-output-serialization-");
  cleanup.push(() => rmSync(control, { recursive: true, force: true }));
  const events = join(control, "events"), release = join(control, "release");
  writeFileSync(events, ""); writeFileSync(join(brain, "counter.txt"), "0");
  const program = (name: string, wait: boolean) => `import {appendFileSync,existsSync,readFileSync,writeFileSync} from "node:fs";
    const path=process.env.BRAIN_WORKER_DATA_ROOT+"/counter.txt", before=Number(readFileSync(path,"utf8"));
    appendFileSync(${JSON.stringify(events)},${JSON.stringify(name + "\n")});
    ${wait ? `while(!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);` : ""}
    writeFileSync(path,String(before+1)); console.log(before);`;
  const command = (name: string, wait: boolean) => ({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program(name, wait)],
    env: {}, credentials: false, gate: "shared" as const, purpose: "serialized maintenance", writeFiles: [events] });
  const first = createHostBoundary({ brainPath: brain, exec: {} });
  const second = createHostBoundary({ brainPath: brain, exec: {} });
  const live = await first.launch(command("first", true));
  const drained = Promise.all([new Response(live.stdout).text(), new Response(live.stderr).text()]);
  let other: ReturnType<typeof second.run> | undefined;
  try {
    const deadline = Date.now() + 5_000;
    while (!readFileSync(events, "utf8").includes("first") && Date.now() < deadline) await Bun.sleep(10);
    expect(readFileSync(events, "utf8")).toBe("first\n");
    other = second.run(command("second", false));
    void other.catch(() => {});
    await Bun.sleep(150);
    expect(readFileSync(events, "utf8"), "MAINTENANCE_OUTPUT_LIFECYCLE_SERIALIZED").toBe("first\n");
    writeFileSync(release, "go");
    expect(await live.exited).toBe(0);
    expect((await drained)[0]).toBe("0\n");
    expect(await other).toMatchObject({ exitCode: 0, stdout: "1\n" });
    expect(readFileSync(join(brain, "counter.txt"), "utf8")).toBe("2");
    expect(readFileSync(events, "utf8")).toBe("first\nsecond\n");
  } finally { writeFileSync(release, "go"); live.kill("SIGKILL"); await live.exited.catch(() => {}); await drained; await other?.catch(() => {}); }
});


test("app close drains its real deferred maintenance refresh before closing the writer gate database", async () => {
  const fixture = await createTestApp({ prepare(brain) {
    mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(brain, "node_modules/.bin/brain"), `#!${process.execPath}\nif(process.argv.includes("--version")) console.log("0.42.0");
else if(process.argv.includes("index")) {await Bun.sleep(700);console.log("{}");} else console.log("{}");`, { mode: 0o755 });
  } });
  try {
    fixture.app.wsHost.governedTurns!.refresh(createKeyedLock());
    const pids = await waitForHostProcesses(join(fixture.brainPath, "node_modules/.bin/brain"), "index");
    expect(pids.length).toBeGreaterThan(0);
    await fixture.app.close();
    expect(pids.filter(hostProcessAlive), "DEFERRED_REFRESH_EXITED_BEFORE_DB_CLOSE").toEqual([]);
    const db = createUiDb(fixture.dbPath);
    try { expect(db.query("SELECT count(*) AS n FROM writer_gate").get(), "DEFERRED_REFRESH_GATE_RELEASED").toEqual({ n: 0 }); }
    finally { db.close(); }
  } finally { await fixture.teardown(); }
});

for (const timing of ["during", "after"] as const) test(`cancellation ${timing} Git preparation starts no maintenance command and releases admission`, async () => {
  const brain = fixture(), state = mkdtempSync("/var/tmp/odysseus-cancel-git-");
  cleanup.push(() => rmSync(state, { recursive: true, force: true }));
  const realGit = Bun.which("git")!;
  const init = Bun.spawnSync([realGit, "-C", brain, "init", "-q"]); expect(init.exitCode, init.stderr.toString()).toBe(0);
  Bun.spawnSync([realGit, "-C", brain, "config", "core.fsmonitor", "false"]);
  const controller = new AbortController(), previousPath = process.env.PATH;
  const fakeGit = join(brain, "git");
  if (timing === "during") {
    writeFileSync(fakeGit, `#!/bin/sh\nsleep 0.6\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${brain}:${previousPath}`;
  }
  const which = Bun.which;
  const selectGit = timing === "during" ? spyOn(Bun, "which").mockImplementation((name, options) => name === "git" ? fakeGit : which(name, options)) : undefined;
  const original = workerSdk.runMaintenanceWorker;
  let injected = false;
  const spy = timing === "after" ? spyOn(workerSdk, "runMaintenanceWorker").mockImplementation(async input => {
    const result = await original(input);
    if (input.command.includes("mktree") && result.exitCode === 0) { injected = true; controller.abort(new DOMException("after Git preparation", "AbortError")); }
    return result;
  }) : undefined;
  const dbPath = join(state, "ui.db"), db = createUiDb(dbPath);
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const heldBefore = processStateLedger().outputStagingHeld;
  let abortedAt = 0;
  try {
    const pending = execution.boundary.launch({ argv: [process.execPath, "--no-env-file", "-e", 'require("node:fs").writeFileSync(process.env.BRAIN_ROOT+"/harbor.md","cancelled command ran");'],
      env: {}, credentials: false, gate: "exclusive", purpose: "cancel Git preparation", signal: controller.signal })
      .then(async worker => { const streams = Promise.all([new Response(worker.stdout).text(),new Response(worker.stderr).text()]); const code = await worker.exited; await streams; return { code }; }, error => error as Error);
    if (timing === "during") {
      const pids = await waitForHostProcesses(fakeGit); expect(pids.length).toBeGreaterThan(0);
      abortedAt = performance.now();
      controller.abort(new DOMException("during Git preparation", "AbortError"));
    }
    expect(await pending, "CANCELLED_GIT_PREPARATION_STARTS_NO_COMMAND").toHaveProperty("name", "AbortError");
    if (timing === "during") expect(performance.now() - abortedAt, "PREPARATION_ABORT_REAPS_ACTIVE_GIT").toBeLessThan(600);
    if (timing === "after") expect(injected, "REAL_GIT_PREPARATION_COMPLETED_BEFORE_ABORT").toBe(true);
    expect(readFileSync(join(brain, "harbor.md"), "utf8")).toBe("Odysseus before launch.\n");
    expect(execution.gate()!.holders()).toEqual([]);
    expect(processStateLedger().outputStagingHeld).toBe(heldBefore);
  } finally { spy?.mockRestore(); selectGit?.mockRestore(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; db.close(); }
});
