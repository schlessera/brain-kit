/**
 * #2284, ruling (c): while a provider folder policy is active, the legacy
 * never-governed host fallback is refused before any host process exists. No
 * outer PID, process group or output EOF bounds a host child's descendants, so
 * a host writer's admission could otherwise end while one of them still
 * replaces a folder that a later governed worker has pinned. Actual offline
 * host processes and a real bubblewrap worker; not Btrfs or separate-UID proof.
 */
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createWriterGate, processStart, type GateHold } from "../src/brain/writer-gate.js";
import { launchAgentWorker, prepareWorkerSandbox } from "../../ui-sdk/src/server/worker-launcher.js";

const OWNER = join(import.meta.dir, "helpers/host-fallback-owner.ts");
async function collect(stream: NodeJS.ReadableStream) { let text = ""; for await (const chunk of stream as AsyncIterable<Buffer>) text += chunk.toString(); return text; }

const cases = [
  ["launch", "no", "group/private", "crash"],
  ["launch", "yes", "group/private", "crash"],
  ["run", "yes", "group", "crash"],
  ["launch", "no", "group/private", "detached"],
] as const;

test.each(cases)("%s (descendant %s, replaces %s, owner %s): a folder policy refuses the old host before a governed worker pins the folder", async (method, descendant, target, scenario) => {
  const root = mkdtempSync("/tmp/odysseus-host-fallback-policy-"), brain = join(root, "brain"), dbPath = join(root, "ui.db");
  mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(brain, "group/private"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"), "---\nschema_version: 1\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]\n---\nAthena reviews policy.\n");
  const db = createUiDb(dbPath), gate = createWriterGate(db, brain);
  const owner = Bun.spawn([process.execPath, OWNER, brain, dbPath, method, descendant, target, scenario],
    { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, BUN_OPTIONS: "--no-env-file" }, stdout: "pipe", stderr: "pipe" });
  const ownerOutput = Promise.all([new Response(owner.stdout).text(), new Response(owner.stderr).text()]);
  const at = (name: string) => join(brain, name);
  const ready = async (...names: string[]) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = names.find(name => existsSync(at(name)));
      if (found) return found;
      if (Date.now() > deadline) throw Error(`owned readiness timeout ${names.join("|")}: ${(await Promise.race([ownerOutput, Bun.sleep(100).then(() => [])])).join("")}`);
      await Bun.sleep(5);
    }
  };
  let old: number | undefined, oldStart: string | null = null, hold: GateHold | undefined;
  let peer: ReturnType<typeof launchAgentWorker> | undefined, peerOutput: Promise<string[]> | undefined;
  try {
    const entered = await ready("old-ready", "owner-refused.json");
    if (entered === "old-ready") { old = Number(readFileSync(at("old.pid"), "utf8")); oldStart = processStart(old); }
    if (scenario === "detached") await ready("owner-completed");
    else { owner.kill("SIGKILL"); await owner.exited; }
    hold = await gate.acquire("shared", "turn:after-old-owner");
    hold.assertPeerFolderPlans!(["group/private"]);
    const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: hold.folderPaths });
    expect(sandbox.profile).toBe("governed");
    peer = launchAgentWorker({ brainPath: brain, sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
      'printf ready > next-ready; IFS= read -r go || exit 46; if mv group/private group/moved-after-peer 2>/dev/null; then printf ROOT_RENAMED; exit 41; fi; printf ROOT_RETAINED'] });
    peerOutput = Promise.all([collect(peer.stdout), collect(peer.stderr)]);
    await ready("next-ready");
    const rootBefore = lstatSync(at("group/private")).ino;
    // Release a surviving old host, if one was ever started, to replace the root.
    writeFileSync(at("old-go"), "go");
    if (old !== undefined) await ready("old-done");
    const rootAfter = lstatSync(at("group/private")).ino;
    peer.stdin.write("go\n"); peer.stdin.end();
    const exit = await peer.exited, output = await peerOutput;
    const refused = existsSync(at("owner-refused.json")) ? JSON.parse(readFileSync(at("owner-refused.json"), "utf8")) as { name: string; message: string } : undefined;
    console.log(JSON.stringify({ case: [method, descendant, target, scenario], refused, oldHostStarted: old !== undefined, rootBefore, rootAfter, exit, output }));
    expect(exit, `CRASHED_HOST_WRITER_CANNOT_INVALIDATE_NEW_NATIVE_PINS: ${output.join("")}`).toBe(0);
    expect(output[0]).toBe("ROOT_RETAINED");
    expect(rootAfter, "RESTRICTED_ROOT_RETAINED").toBe(rootBefore);
    expect(refused?.name, "FOLDER_POLICY_REFUSES_OWNED_HOST_FALLBACK").toBe("HostFallbackRefusedError");
    expect(old, "NO_HOST_PROCESS_EXISTS_UNDER_FOLDER_POLICY").toBeUndefined();
  } finally {
    owner.kill("SIGKILL"); await owner.exited;
    if (old !== undefined && oldStart !== null && processStart(old) === oldStart) try { process.kill(old, "SIGKILL"); } catch {}
    peer?.kill(); if (peer) await peer.exited; await peerOutput;
    // A surviving host descendant can inherit the owner's pipes; settle after killing that exact owned child.
    await ownerOutput; hold?.release(); db.close(); rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
