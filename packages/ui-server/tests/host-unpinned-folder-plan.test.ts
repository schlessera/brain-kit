import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createUiDb } from "../src/db/client.js";
import { createHostExecution } from "../src/brain/host-execution.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { HostFallbackRefusedError } from "../src/brain/writer-gate.js";
import { createGovernedTurns } from "../src/brain/governed-turn.js";
import { launchAgentWorker } from "../../ui-sdk/src/server/worker-launcher.js";
installFixtureNativeStartupViews();
async function collect(stream: NodeJS.ReadableStream) { let text = ""; for await (const chunk of stream as AsyncIterable<Buffer>) text += chunk.toString(); return text; }
// Before #2284 this host started under the existing policy, recorded its
// advisory roots, and replaced the root under a postmount-qualified worker.
// Ruling (c) refuses it before it exists; the root witness must stay retained.
for (const renamed of ["group/private", "group"] as const) test(`an existing folder policy refuses the host plan before it could replace ${renamed} under physical pins`, async () => {
  const root = mkdtempSync("/tmp/odysseus-host-transition-");
  const brain = join(root, "brain"), dbPath = join(root, "state/ui.db");
  mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(root, "state")); mkdirSync(join(brain, "group/private"), { recursive: true });
  const policy = join(brain, "context/policies/governance.md"); writeFileSync(policy, "---\nschema_version: 1\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]\n---\nAthena reviews policy.\n");
  const db = createUiDb(dbPath), execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const fallback = createHostBoundary({ brainPath: brain, dbPath, gate: () => execution.gate(), requireGate: true,
    history: () => execution.manifests()!.hasHistory(), workerHost: () => ({ ok: false, requirement: "fictional pre-governed unavailable worker" }) });
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {} });
  let old: Awaited<ReturnType<typeof fallback.launch>> | undefined, oldOutput: Promise<string[]> | undefined, refusal: unknown;
  let admitted: Awaited<ReturnType<typeof turns.begin>> | undefined, next: ReturnType<typeof launchAgentWorker> | undefined, nextOutput: Promise<string[]> | undefined;
  const ready = async (path: string) => { const deadline = Date.now() + 5000; while (!existsSync(join(brain, path))) { if (Date.now() >= deadline) throw Error(`readiness timeout ${path}`); await Bun.sleep(5); } };
  try {
    expect(fallback.isolated()).toBe(false);
    try {
      old = await fallback.launch({ argv: ["/bin/sh", "-c", `printf ready > old-ready.md; i=0; while ! test -f old-go.md; do i=$((i+1)); test $i -gt 1500 && exit 47; sleep 0.01; done; mv ${renamed} ${renamed}-retired || exit 44; mkdir -p group/private || exit 45; printf Athena > group/private/born.md`], env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "shared", purpose: "old host maintenance", timeoutMs: 15000 });
      oldOutput = Promise.all([new Response(old.stdout).text(), new Response(old.stderr).text()]); await ready("old-ready.md");
    } catch (error) { refusal = error; }
    expect(refusal, "EXISTING_FOLDER_POLICY_REFUSES_HOST_PLAN").toBeInstanceOf(HostFallbackRefusedError);
    expect(existsSync(join(brain, "old-ready.md")), "NO_HOST_PROCESS_UNDER_EXISTING_FOLDER_POLICY").toBe(false);
    expect(db.query("SELECT mode, purpose, folder_topology FROM writer_gate").all(), "REFUSED_HOST_LEAVES_NO_LEDGER_ROW").toEqual([]);
    admitted = await turns.begin("provider-folder-after-refused-host", new AbortController().signal);
    next = launchAgentWorker({ brainPath: brain, sandbox: admitted.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c", "printf ready > next-ready.md; IFS= read -r go || exit 46; if mv group/private group/moved-after-peer 2>/dev/null; then printf ROOT_RENAMED; exit 41; fi; printf ROOT_RETAINED"] });
    nextOutput = Promise.all([collect(next.stdout), collect(next.stderr)]); await ready("next-ready.md");
    const rootBefore = lstatSync(join(brain, "group/private")).ino;
    writeFileSync(join(brain, "old-go.md"), "go");
    if (old) expect(await old.exited, (await oldOutput!).join("")).toBe(0);
    const rootAfter = lstatSync(join(brain, "group/private")).ino;
    next.stdin.write("go\n"); next.stdin.end();
    const witness = { exit: await next.exited, output: (await nextOutput).join("") };
    console.log(JSON.stringify({ renamed, refusal: (refusal as Error | undefined)?.name, rootBefore, rootAfter, admittedProfile: admitted.sandbox.profile, witness }));
    expect(witness.exit, `HOST_PLAN_CANNOT_INVALIDATE_PHYSICAL_FOLDER_PINS: ${witness.output}`).toBe(0);
    expect(witness.output).toContain("ROOT_RETAINED");
    expect(rootAfter, "PINNED_ROOT_RETAINED").toBe(rootBefore);
  } finally {
    old?.kill("SIGKILL"); if (old) await old.exited; await oldOutput;
    next?.kill(); if (next) await next.exited; await nextOutput;
    try { await admitted?.end(); await turns.close(); } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
