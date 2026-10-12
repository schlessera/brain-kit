import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMaintenanceOutput } from "../src/brain/maintenance-output.js";
import { listDirectory } from "../src/files/walker.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";

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
