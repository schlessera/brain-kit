/** Real worker-owned Git inputs and explicit refusal on unknown policy bytes. */
import { expect } from "bun:test";
import { lstatSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { launchAgentWorker, probeWorkerHost } from "../src/server/worker-launcher.js";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView } from "../src/server/worker-startup-view.js";
import { prepareMaintenanceOutput } from "../../ui-server/src/brain/maintenance-output.js";
import { prepareMaintenanceGit } from "../../ui-server/src/brain/maintenance-git.js";
import { createHostBoundary } from "../../ui-server/src/brain/host-boundary.js";
import type { MaintenanceCommand } from "../src/server/maintenance-worker.js";
const brain = "/brain-fixture/brain", manager = createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" });
const probe = probeWorkerHost(brain, { profile: "governed", stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2 });
if (!probe.ok) throw Error("PRIVATE_GIT_INPUT_REAL_IDENTITY_PROBE");
async function worker(code: string) {
  const child = launchAgentWorker({ brainPath: brain, sandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
    stateBytes: 1024 ** 2, turnTempBytes: 1024 ** 2, env: {}, command: ["/usr/bin/python3", "-I", "-S", "-c", code] });
  child.stdin.end();
  const output = new Response(Readable.toWeb(child.stdout as Readable) as unknown as ReadableStream).text();
  const error = new Response(Readable.toWeb(child.stderr as Readable) as unknown as ReadableStream).text();
  try { const [stdout, stderr, status] = await Promise.all([output, error, child.exited]); expect(status, stderr).toBe(0); return stdout; }
  finally { child.state?.close(); child.turnTemp?.close(); }
}
const creation = await worker(String.raw`import os,json
r=${JSON.stringify(brain)}
os.mkdir(r+"/private",0o700)
open(r+"/private/.gitattributes","w").write("*.md odysseus=ithaca\n")
os.chmod(r+"/private/.gitattributes",0o600)
open(r+"/private/result.md","w").write("Odysseus private voyage\n")
os.chmod(r+"/private/result.md",0o600)
os.mkdir(r+"/private-hooks",0o700)
open(r+"/private-hooks/odysseus-private","w").write("Odysseus private hook input")
os.chmod(r+"/private-hooks/odysseus-private",0o600)
open(r+"/private-hooks/pre-commit","w").write('#!/bin/sh\numask 0002\nprintf "Odysseus private hook" > "$BRAIN_ROOT/.brain-private-hook-ran"\n')
os.chmod(r+"/private-hooks/pre-commit",0o700)
paths=["private/.gitattributes","private/result.md","private-hooks/odysseus-private","private-hooks/pre-commit"]
print(json.dumps({"uid":os.getuid(),"gid":os.getgid(),"files":{p:{"uid":os.lstat(r+"/"+p).st_uid,"mode":os.lstat(r+"/"+p).st_mode & 0o777} for p in paths}}))`);
const created = JSON.parse(creation);
expect(created.uid, "PRIVATE_GIT_INPUT_ACTUAL_WORKER_UID").toBe(21002);
for (const path of ["private/.gitattributes", "private/result.md", "private-hooks/odysseus-private", "private-hooks/pre-commit"]) {
  expect(created.files[path].uid, "PRIVATE_GIT_INPUT_WORKER_FILE_OWNED").toBe(21002);
  expect(created.files[path].mode, "PRIVATE_GIT_INPUT_WORKER_FILE_MODE_PRESERVED").toBe(path.endsWith("pre-commit") ? 0o700 : 0o600);
}
for (const path of ["private", "private-hooks"]) {
  const info = lstatSync(`${brain}/${path}`);
  expect(info.uid, "PRIVATE_GIT_INPUT_WORKER_OWNED").toBe(21002);
  expect(info.mode & 0o777, "PRIVATE_GIT_INPUT_MODE_PRESERVED").toBe(0o700);
}
expect(() => readFileSync(`${brain}/private/.gitattributes`), "SERVER_CANNOT_READ_PRIVATE_ATTRIBUTES").toThrow();
expect(() => readFileSync(`${brain}/private-hooks/odysseus-private`), "SERVER_CANNOT_READ_PRIVATE_HOOK_INPUT").toThrow();
const boundary = createHostBoundary({ brainPath: brain, dbPath: "/identity-server-private/private-git-inputs.db", nativeManager: manager });
await boundary.prepare();
let actual: Awaited<ReturnType<typeof boundary.run>> | undefined, failure: unknown;
try { actual = await boundary.run({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", String.raw`
process.umask(0o002);
function git(args){const p=Bun.spawnSync(["git",...args],{stdout:"pipe",stderr:"pipe"});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString().trim();}
const fs=require("node:fs");
if(git(["check-attr","odysseus","--","private/result.md"])!=="private/result.md: odysseus: ithaca")throw Error("ACTUAL_PRIVATE_ATTRIBUTE_POLICY");
if(!fs.readdirSync("/tmp/brain-maintenance-git/hooks").includes("odysseus-private"))throw Error("ACTUAL_PRIVATE_HOOK_NAMES");
fs.writeFileSync(process.env.BRAIN_ROOT+"/private-git-commit.md","Odysseus returns to Ithaca.\n");git(["add","--","private-git-commit.md"]);
git(["-c","user.name=Odysseus","-c","user.email=odysseus@example.invalid","commit","-qm","Record private Git inputs"]);
if(fs.readFileSync(process.env.BRAIN_ROOT+"/.brain-private-hook-ran","utf8")!=="Odysseus private hook")throw Error("ACTUAL_PRIVATE_HOOK_EXECUTED");
console.log("PRIVATE_GIT_ATTRIBUTE_HOOK_CONSUMERS_PASS");`],
  env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, credentials: false, gate: "shared", purpose: "Odysseus private Git inputs" }); } catch (error) { failure = error; }
expect(failure, "PRIVATE_GIT_SOURCE_COLLECTION_SUCCEEDS").toBeUndefined();
expect(actual!.exitCode, actual!.stderr).toBe(0);
expect(actual!.stdout, "ACTUAL_PRIVATE_GIT_CONSUMERS").toBe("PRIVATE_GIT_ATTRIBUTE_HOOK_CONSUMERS_PASS\n");
const base = (): MaintenanceCommand => ({ brainPath: brain, command: ["/bin/true"], credentials: false, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
for (const kind of ["zero-attribute", "zero-directory", "attribute-alias", "foreign-root", "closed", "changed-context"] as const) {
  if (kind === "zero-attribute") await worker(String.raw`import os;p=${JSON.stringify(brain)}+"/private/.gitattributes";os.unlink(p);open(p,"w").write("*.md odysseus=ithaca\n");os.chmod(p,0)`);
  if (kind === "zero-directory") await worker(String.raw`import os;os.mkdir(${JSON.stringify(brain)}+"/odysseus-unknown",0)`);
  if (kind === "attribute-alias") await worker(String.raw`import os;os.symlink("private/.gitattributes",${JSON.stringify(brain)}+"/.gitattributes")`);
  const view = await prepareNativeWorkerStartupView(brain, manager);
  try {
    const outputs = await prepareMaintenanceOutput(brain, { startupView: view });
    const descriptor = Object.getOwnPropertyDescriptor(outputs.view, "root")!, spawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn")!, spawn = Bun.spawn;
    const command = base(); let changed = false, consumer = false;
    try {
      if (kind === "foreign-root") Object.defineProperty(outputs.view, "root", { ...descriptor, value: "/tmp" });
      if (kind === "closed") await outputs.cleanup();
      if (kind === "changed-context") Object.defineProperty(Bun, "spawn", { ...spawnDescriptor, value: (...args: any[]) => {
        const options = Array.isArray(args[0]) ? args[1] : args[0], launch = options?.env?.BRAIN_WORKER_LAUNCH;
        const payload = launch ? JSON.parse(launch) : undefined;
        if (payload?.command?.some((part: string) => part.includes("maintenance-git-entry"))) consumer = true;
        const result = Reflect.apply(spawn, Bun, args);
        if (payload?.command?.some((part: string) => part.includes("maintenance-git-source"))) { command.command = ["/bin/false"]; changed = true; }
        return result;
      } });
      await expect(prepareMaintenanceGit(command, outputs), `PRIVATE_GIT_INPUT_REFUSED_${kind}`).rejects.toThrow();
      if (kind === "changed-context") { expect(changed, "PRIVATE_GIT_CONTEXT_MUTATION_EXECUTED").toBe(true); expect(consumer, "PRIVATE_GIT_NO_CONSUMER_AFTER_CONTEXT_CHANGE").toBe(false); }
      console.log(JSON.stringify({ actualPrivateGitInputRefusal: kind }));
    } finally {
      Object.defineProperty(Bun, "spawn", spawnDescriptor); Object.defineProperty(outputs.view, "root", descriptor);
      await outputs.cleanup();
    }
  } finally {
    await view.cleanup();
    if (kind === "zero-attribute") await worker(String.raw`import os;p=${JSON.stringify(brain)}+"/private/.gitattributes";os.unlink(p);open(p,"w").write("*.md odysseus=ithaca\n");os.chmod(p,0o600)`);
    if (kind === "zero-directory") await worker(String.raw`import os;os.rmdir(${JSON.stringify(brain)}+"/odysseus-unknown")`);
    if (kind === "attribute-alias") await worker(String.raw`import os;os.unlink(${JSON.stringify(brain)}+"/.gitattributes")`);
  }
}
console.log(JSON.stringify({ actualPrivateGitSources: { uid: 21002, serverReadDenied: true, attributePolicy: "ithaca", repositoryHookExecuted: true } }));
