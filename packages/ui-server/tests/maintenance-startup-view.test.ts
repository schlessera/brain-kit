import * as fs from "node:fs";
import { afterEach, expect, test, spyOn } from "bun:test";
import { chmodSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMaintenanceOutput } from "../src/brain/maintenance-output.js";
import { listDirectory } from "../src/files/walker.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { createHostExecution } from "../src/brain/host-execution.js";
import { createUiDb } from "../src/db/client.js";
import { processStateLedger } from "../../ui-sdk/src/server/worker-state-budget.js";

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
