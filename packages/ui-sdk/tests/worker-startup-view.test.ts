import * as fs from "node:fs";
import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, writeSync, ftruncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerStartupView } from "../src/server/worker-startup-view.js";
import { text } from "node:stream/consumers";
import { runMaintenanceWorker } from "../src/server/maintenance-worker.js";
import { once } from "node:events";
import { workerCommand, prepareWorkerSandbox, launchAgentWorker } from "../src/server/worker-launcher.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-startup-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"); mkdirSync(brain);
  writeFileSync(join(brain, "brain.config.ts"), 'import value from "./helper.ts"; export default value;');
  writeFileSync(join(brain, "helper.ts"), 'export default "Odysseus before launch";');
  return brain;
}
test("startup bytes are independent and absence is preserved", () => {
  const brain = fixture();
  const view = createWorkerStartupView(brain); cleanup.push(view.cleanup);
  writeFileSync(join(brain, "helper.ts"), 'export default "Odysseus during launch";');
  writeFileSync(join(brain, ".mcp.json"), "{}");
  expect(readFileSync(join(view.root, "helper.ts"), "utf8")).toContain("before launch");
  expect(Bun.file(join(view.root, ".mcp.json")).size).toBe(0);
});

test("a real startup-view worker imports the old dependency after a governed edit", async () => {
  const brain = fixture();
  const startupView = createWorkerStartupView(brain); cleanup.push(startupView.cleanup);
  const bun = process.execPath;
  const sandbox = prepareWorkerSandbox(brain, { profile: "strict", areas: [], readPaths: [bun] });
  const child = Bun.spawn(workerCommand({ brainPath: brain, startupView, sandbox, env: {},
    command: ["/bin/sh", "-c", 'printf "ready\\n"; IFS= read -r go; [ "$go" = go ] || exit 40; exec "$1" --no-env-file -e \'console.log((await import("./brain.config.ts")).default); console.log(await Bun.file(".mcp.json").exists())\'', "odysseus-reader", bun] }),
    { cwd: "/", env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stream = child.stdout.getReader();
  const ready = await stream.read();
  expect(Buffer.from(ready.value ?? []).toString()).toBe("ready\n");
  writeFileSync(join(brain, "helper.ts"), 'export default "Odysseus during launch";');
  writeFileSync(join(brain, ".mcp.json"), "{}");
  child.stdin.write("go\n"); child.stdin.end();
  let output = "";
  for (;;) { const next = await stream.read(); if (next.done) break; output += Buffer.from(next.value).toString(); }
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  expect(output).toBe("Odysseus before launch\nfalse\n");
});

test("strict persistent-area aliases cannot expose a governed peer's later configuration", async () => {
  const brain = fixture();
  mkdirSync(join(brain, "workspaces"));
  writeFileSync(join(brain, "workspaces/helper.ts"), 'export default "Odysseus before launch";');
  writeFileSync(join(brain, "brain.config.ts"), 'export {default} from "/tmp/brain-worker-areas/workspaces/helper.ts";');
  const sandbox = prepareWorkerSandbox(brain, { profile: "strict", areas: ["workspaces"], readPaths: [process.execPath] });
  const worker = launchAgentWorker({ brainPath: brain, sandbox, env: {}, command: ["/bin/sh", "-c",
    'printf "ready\\n"; IFS= read -r go; exec "$1" --no-env-file -e \'console.log((await import("./brain.config.ts")).default)\'', "odysseus-reader", process.execPath] });
  try {
    const [ready] = await once(worker.stdout, "data");
    expect(String(ready)).toBe("ready\n");
    const peer = prepareWorkerSandbox(brain, { profile: "governed", areas: [] });
    const writer = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox: peer, env: {}, command: ["/bin/sh", "-c",
      `printf '%s' 'export default "Odysseus during launch";' > workspaces/helper.ts`] }), { env: {}, stdout: "pipe", stderr: "pipe" });
    expect(writer.exitCode, writer.stderr.toString()).toBe(0);
    let output = "", errors = "";
    worker.stdout.on("data", chunk => { output += String(chunk); }); worker.stderr.on("data", chunk => { errors += String(chunk); });
    worker.stdin.end("go\n");
    expect(await worker.exited, errors).toBe(0);
    expect(output, "STRICT_OUTPUT_ALIAS_FROZEN").toBe("Odysseus before launch\n");
  } finally { worker.kill("SIGKILL"); }
});


test("startup refuses a previously copied input changed while copying another input", () => {
  const brain = fixture();
  const original = fs.readSync;
  const originalList = fs.readdirSync;
  const list = spyOn(fs, "readdirSync").mockImplementation((...args: any[]) =>
    (originalList as (...input: any[]) => any)(...args).sort());
  let altered = false;
  const read = spyOn(fs, "readSync").mockImplementation((...args: any[]) => {
    const name = fs.readlinkSync(`/proc/self/fd/${args[0]}`);
    if (!altered && name.endsWith("/helper.ts")) {
      altered = true;
      writeFileSync(join(brain, "brain.config.ts"), 'export default "Athena changes the config";');
    }
    return (original as (...input: any[]) => number)(...args);
  });
  try {
    expect(() => createWorkerStartupView(brain), "STARTUP_REVALIDATES_COPIED_INPUTS").toThrow("startup input changed");
    expect(altered).toBe(true);
  } finally { read.mockRestore(); list.mockRestore(); }
});


test("strict output publication holds the same path lock as a governed native writer", async () => {
  const { createKeyedLock } = await import("../src/server/keyed-lock.js");
  const brain = fixture(); mkdirSync(join(brain, "workspaces"));
  const destination = join(brain, "workspaces/shared.md"); writeFileSync(destination, "before");
  const lock = createKeyedLock(); const release = await lock.acquire(`path:${destination}`);
  const sandbox = prepareWorkerSandbox(brain, { profile: "strict", areas: ["workspaces"] });
  const worker = launchAgentWorker({ brainPath: brain, sandbox, outputLock: lock, env: {},
    command: ["/bin/sh", "-c", "printf staged > /tmp/brain-worker-areas/workspaces/shared.md"] });
  let settled = false;
  const done = worker.exited.finally(() => { settled = true; });
  void done.catch(() => {});
  try {
    worker.stdout.resume();
    await once(worker.stdout, "end");
    await Bun.sleep(20);
    expect(settled, "PUBLICATION_RETAINS_NATIVE_PATH_LOCK").toBe(false);
    writeFileSync(destination, "Penelope's newer content"); release();
    await expect(done).rejects.toThrow("stale maintenance output");
    expect(readFileSync(destination, "utf8")).toBe("Penelope's newer content");
  } finally { release(); worker.kill("SIGKILL"); await worker.exited.catch(() => {}); }
});


test("startup preserves sparse zero extents and mixed bytes within its bounded storage", () => {
  const brain = fixture(), path = join(brain, "raft.bin");
  const length = 512 * 1024 ** 2 + 17;
  const fd = openSync(path, "w", 0o640);
  try { writeSync(fd, Buffer.from("Odysseus"), 0, 8, 0); writeSync(fd, Buffer.from("Ithaca"), 0, 6, length - 6); ftruncateSync(fd, length); }
  finally { closeSync(fd); }
  const view = createWorkerStartupView(brain); cleanup.push(view.cleanup);
  const saved = join(view.root, "raft.bin"), info = statSync(saved);
  expect(info.size, "SPARSE_STARTUP_LOGICAL_SIZE").toBe(length);
  expect(info.mode & 0o777).toBe(0o640);
  expect(info.blocks * 512, "SPARSE_STARTUP_ALLOCATED_BYTES").toBeLessThan(1024 ** 2);
  const held = openSync(saved, "r"), bytes = Buffer.alloc(8);
  try {
    fs.readSync(held, bytes, 0, 8, 0); expect(bytes.toString()).toBe("Odysseus");
    fs.readSync(held, bytes, 0, 8, 256 * 1024 ** 2); expect(bytes).toEqual(Buffer.alloc(8));
    fs.readSync(held, bytes, 0, 6, length - 6); expect(bytes.subarray(0, 6).toString()).toBe("Ithaca");
  } finally { closeSync(held); }
});


for (const mode of ["strict", "restricted", "maintenance"] as const) for (const link of ["relative", "absolute", "link-parent"] as const) {
  test(`${mode} snapshot masks the ${link} secret link in its worker-visible view`, async () => {
    const brain = fixture();
    mkdirSync(join(brain, "tokens/deeper"), { recursive: true });
    writeFileSync(join(brain, "tokens/harbor.txt"), "BRAIN_DOTENV_MARK=Odysseus\n");
    if (link === "link-parent") fs.symlinkSync("tokens/deeper", join(brain, "link"));
    fs.symlinkSync(link === "relative" ? "tokens/harbor.txt" : link === "absolute" ? join(brain, "tokens/harbor.txt")
      : "link/../harbor.txt", join(brain, ".env"));
    const program = `import{readFileSync}from"node:fs";const read=p=>{try{return readFileSync(p,"utf8")}catch(e){return e.code}};console.log(JSON.stringify({alias:read(".env"),target:read("tokens/harbor.txt"),public:read("helper.ts")}));`;
    let output: string;
    if (mode === "maintenance") {
      const result = await runMaintenanceWorker({ brainPath: brain, credentials: false, env: {},
        command: [process.execPath, "--no-env-file", "-e", program] });
      expect(result.exitCode, result.stderr).toBe(0); output = result.stdout;
    } else {
      const sandbox = prepareWorkerSandbox(brain, { profile: "strict", restricted: mode === "restricted", areas: [], readPaths: [process.execPath] });
      const inferenceDir = mode === "restricted" ? mkdtempSync("/var/tmp/odysseus-secret-relay-") : undefined;
      if (inferenceDir) cleanup.push(() => rmSync(inferenceDir, { recursive: true, force: true }));
      const worker = launchAgentWorker({ brainPath: brain, sandbox, ...(inferenceDir ? { restricted: { readPaths: [process.execPath], inferenceDir } } : {}), env: {}, command: [process.execPath, "--no-env-file", "-e", program] });
      try {
        const streams = Promise.all([text(worker.stdout), text(worker.stderr)]);
        const code = await worker.exited, [stdout, stderr] = await streams;
        expect(code, stderr).toBe(0); output = stdout;
      } finally { worker.kill("SIGKILL"); }
    }
    const result = JSON.parse(output.trim());
    expect(["", "EACCES"], "SNAPSHOT_SECRET_LINK_MASKED").toContain(result.alias);
    expect(["", "EACCES"], "SNAPSHOT_SECRET_DESTINATION_MASKED").toContain(result.target);
    expect(result.public).toContain("Odysseus before launch");
  });
}
