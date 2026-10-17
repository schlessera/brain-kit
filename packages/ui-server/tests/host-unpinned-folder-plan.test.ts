import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createUiDb } from "../src/db/client.js";
import { createHostExecution } from "../src/brain/host-execution.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { createGovernedTurns } from "../src/brain/governed-turn.js";
import { launchAgentWorker } from "../../ui-sdk/src/server/worker-launcher.js";
installFixtureNativeStartupViews();
async function collect(stream: NodeJS.ReadableStream) { let text = ""; for await (const chunk of stream as AsyncIterable<Buffer>) text += chunk.toString(); return text; }
for (const renamed of ["group/private", "group"] as const) test(`a non-null host plan cannot attest physical pins after ${renamed} is replaced`, async () => {
  const root = mkdtempSync("/tmp/odysseus-host-transition-");
  const brain = join(root, "brain"), dbPath = join(root, "state/ui.db");
  mkdirSync(join(brain, "context/policies"), { recursive: true }); mkdirSync(join(root, "state")); mkdirSync(join(brain, "group/private"), { recursive: true });
  const policy = join(brain, "context/policies/governance.md"); writeFileSync(policy, "---\nschema_version: 1\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]\n---\nAthena reviews policy.\n");
  const db = createUiDb(dbPath), execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const fallback = createHostBoundary({ brainPath: brain, dbPath, gate: () => execution.gate(), requireGate: true,
    history: () => execution.manifests()!.hasHistory(), workerHost: () => ({ ok: false, requirement: "fictional pre-governed unavailable worker" }) });
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {} });
  let old: Awaited<ReturnType<typeof fallback.launch>> | undefined, oldOutput: Promise<string[]> | undefined;
  let admitted: Awaited<ReturnType<typeof turns.begin>> | undefined, next: ReturnType<typeof launchAgentWorker> | undefined, nextOutput: Promise<string[]> | undefined, refusal: unknown;
  const ready = async (path: string) => { const deadline = Date.now() + 5000; while (!existsSync(join(brain, path))) { if (Date.now() >= deadline) throw Error(`readiness timeout ${path}`); await Bun.sleep(5); } };
  try {
    expect(fallback.isolated()).toBe(false);
    old = await fallback.launch({ argv: ["/bin/sh", "-c", `printf ready > old-ready.md; while ! test -f old-go.md; do sleep 0.01; done; mv ${renamed} ${renamed}-retired || exit 44; mkdir -p group/private || exit 45; printf Athena > group/private/born.md`], env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "shared", purpose: "old host maintenance", timeoutMs: 15000 });
    oldOutput = Promise.all([new Response(old.stdout).text(), new Response(old.stderr).text()]); await ready("old-ready.md");
    const peersBefore = execution.gate()!.holders();
    const plansBefore = db.query("SELECT mode, purpose, folder_topology FROM writer_gate").all();
    const rootBefore = lstatSync(join(brain,"group/private")).ino;
    expect(plansBefore.length).toBe(1);
    expect(JSON.stringify(plansBefore),"EXISTING_POLICY_ENTERS_OLD_HOST_LEDGER_PLAN").toContain("group/private");
    writeFileSync(policy, "---\nschema_version: 1\nproviders: [{ paths: [group/private/**], allow: [anthropic] }]\n---\nAthena reviews policy.\n");
    try { admitted = await turns.begin("transition-to-provider-folder", new AbortController().signal); } catch (error) { refusal = error; }
    if (admitted) {
      next = launchAgentWorker({ brainPath: brain, sandbox: admitted.sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c", "printf ready > next-ready.md; IFS= read -r go || exit 46; if mv group/private group/moved-after-peer 2>/dev/null; then printf ROOT_RENAMED; exit 41; fi; printf ROOT_RETAINED"] });
      nextOutput = Promise.all([collect(next.stdout), collect(next.stderr)]); await ready("next-ready.md");
    }
    writeFileSync(join(brain, "old-go.md"), "go"); expect(await old.exited, (await oldOutput).join("")).toBe(0);
    const rootAfter=lstatSync(join(brain,"group/private")).ino;
    expect(rootAfter,"OLD_HOST_RECREATED_ROOT_AFTER_POSTMOUNT_QUALIFICATION").not.toBe(rootBefore);
    let witness: { exit: number; output: string } | undefined;
    if (next) { next.stdin.write("go\n"); next.stdin.end(); witness = { exit: await next.exited, output: (await nextOutput!).join("") }; expect(witness.exit, witness.output).toBe(41); expect(witness.output).toContain("ROOT_RENAMED"); }
    console.log(JSON.stringify({ renamed, declaredOldGate: "shared", requireGate: true, peersBefore, plansBefore, rootBefore, rootAfter, admittedProfile: admitted?.sandbox.profile, postmountQualifiedNewWriter: Boolean(next), witness }));
    expect(String(refusal), "NONNULL_HOST_PLAN_IS_NOT_PHYSICAL_FOLDER_ATTESTATION").toContain("active peer");
  } finally {
    old?.kill(); if (old) await old.exited; await oldOutput;
    next?.kill(); if (next) await next.exited; await nextOutput;
    try { await admitted?.end(); await turns.close(); } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
