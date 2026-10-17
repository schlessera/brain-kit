/** Actual Btrfs publication control; invoked by the existing owned native fixture. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, existsSync, chmodSync, statSync, rmSync } from "node:fs";
import { text as streamText } from "node:stream/consumers";
import { join } from "node:path";
import { serveNativeBrainManager } from "../../packages/ui-sdk/src/server/native-brain-manager.js";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { createWriterGate } from "../../packages/ui-server/src/brain/writer-gate.js";
import { createHostBoundary } from "../../packages/ui-server/src/brain/host-boundary.js";
import { gitCheckIgnored } from "../../packages/ui-server/src/schedules/service.js";
import { prepareWorkerSandbox, launchAgentWorker } from "../../packages/ui-sdk/src/server/worker-launcher.js";

export async function proveScheduleFolderAdmission(artifacts: string): Promise<void> {
  const command = (argv: string[]) => {
    const result = Bun.spawnSync(argv);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    return result.stdout.toString();
  };
  for (const target of ["group/private", "group"] as const) {
    const name = target === "group" ? "ancestor" : "root";
    // The existing fixture owns this top-level Btrfs mount and its brain.
    const store = "/brain-fixture", brain = join(store, "brain");
    const outputDirectory = join(artifacts, `schedule-${name}`);
    mkdirSync(outputDirectory, { recursive: true });
    for (const path of ["context/policies", "group/private", "notes", "node_modules/.bin", ".git/hooks", ".git/info", ".git/modules"])
      mkdirSync(join(brain, path), { recursive: true });
    rmSync(join(brain, "reader-ready.md"), { force: true });
    const policy = join(brain, "context/policies/governance.md");
    writeFileSync(policy, "---\nschema_version: 1\nproviders: [{paths: [group/private/**], allow: [anthropic]}]\n---\nAthena reviews policy.\n");
    // Each case starts without the previous case's permitted publication.
    if (existsSync(join(brain, "notes/allowed.md"))) command(["/bin/rm", join(brain, "notes/allowed.md")]);
    writeFileSync(join(brain, "node_modules/.bin/git"), `#!/bin/sh\nprintf Athena > "$BRAIN_ROOT/notes/allowed.md"\nrm -r "$BRAIN_ROOT/${target}" || exit 43\n`);
    chmodSync(join(brain, "node_modules/.bin/git"), 0o755);
    const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(command(["btrfs", "subvolume", "show", brain]))![1]!.replaceAll("-", "");
    const device = "/dev/brain-native-proof-loop";
    const fsid = /^fsid\s+([0-9a-f-]+)/m.exec(command(["btrfs", "inspect-internal", "dump-super", device]))![1]!;
    mkdirSync("/native-runtime", { recursive: true, mode: 0o755 });
    const socketPath = `/native-runtime/schedule-${name}.sock`;
    const service = await serveNativeBrainManager({ storePath: store, devicePath: device, fsid, brainUuid, socketPath,
      appUid: 0, appGid: 0, capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2,
      stageAllowanceBytes: 256 * 1024 ** 2, stageBudgetBytes: 512 * 1024 ** 2 });
    const dbPath = join(outputDirectory, "ui.db"), db = createUiDb(dbPath), gate = createWriterGate(db, brain);
    let peer: ReturnType<typeof launchAgentWorker> | undefined, hold: Awaited<ReturnType<typeof gate.acquire>> | undefined;
    let output: Promise<string[]> | undefined;
    const admissions: { mode: string; folders: readonly string[] | undefined; holders: number }[] = [];
    const observedGate = { ...gate, async acquire(...args: Parameters<typeof gate.acquire>) {
      const admitted = await gate.acquire(...args);
      admissions.push({ mode: admitted.mode, folders: admitted.folderPaths, holders: gate.holders().length });
      return admitted;
    } };
    try {
      const manager = createNativeBrainManagerClient({ socketPath });
      const boundary = createHostBoundary({ brainPath: brain, dbPath, nativeManager: manager, profile: "governed",
        requireGate: true, gate: () => observedGate, history: () => true });
      assert.equal((await boundary.prepare()).available, true, "ACTUAL_NATIVE_MAINTENANCE_QUALIFIES");
      hold = await gate.acquire("shared", "turn:odysseus");
      hold.assertPeerFolderPlans!(["group/private"]);
      const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: hold.folderPaths });
      assert.equal(sandbox.profile, "governed");
      peer = launchAgentWorker({ brainPath: brain, sandbox, env: { PATH: "/usr/bin:/bin" }, command: ["/bin/sh", "-c",
        'printf ready > reader-ready.md; IFS= read -r go || exit 46; if mv group/private group/moved 2>/dev/null; then exit 41; fi; if mv group group-moved 2>/dev/null; then exit 42; fi; printf Penelope > group/private/peer.md; printf Odysseus > notes/peer.md; printf ROOTS_RETAINED'] });
      output = Promise.all([streamText(peer.stdout),
        streamText(peer.stderr)]);
      const deadline = Date.now() + 5000;
      while (!existsSync(join(brain, "reader-ready.md"))) {
        if (Date.now() > deadline) throw Error("Native schedule peer readiness deadline");
        await Bun.sleep(5);
      }
      const before = [statSync(join(brain, "group")).ino, statSync(join(brain, "group/private")).ino];
      // Retired policy roots still belong to an active peer and its publishers.
      writeFileSync(policy, "---\nschema_version: 1\nproviders: []\n---\nAthena retires the restriction.\n");
      let refusal: unknown;
      try { await gitCheckIgnored(brain, boundary)("notes/odysseus.md"); }
      catch (error) { refusal = error; }
      const after = ["group", "group/private"].map(path => existsSync(join(brain, path)) ? statSync(join(brain, path)).ino : null);
      assert.deepEqual(after, before, "UNGATED_SCHEDULE_GIT_CANNOT_REPLACE_ACTIVE_PROVIDER_FOLDER");
      assert.match(String(refusal), /retained provider folder topology/, "NATIVE_PUBLICATION_REFUSES_REMOVAL");
      assert.equal(existsSync(join(brain, "notes/allowed.md")), false, "REFUSED_PUBLICATION_HAS_NO_SIBLING_EFFECT");
      assert.deepEqual(admissions, [{ mode: "shared", folders: ["group/private"], holders: 2 }], "SCHEDULE_INHERITS_ACTIVE_PEER_ROOTS_AFTER_POLICY_REMOVAL");
      assert.equal(gate.holders().length, 1, "SCHEDULE_RELEASES_ONLY_OWN_ADMISSION");
      writeFileSync(join(brain, "node_modules/.bin/git"), '#!/bin/sh\nprintf Athena > "$BRAIN_ROOT/notes/allowed.md"\n');
      const ignored = await gitCheckIgnored(brain, boundary)("notes/odysseus.md");
      assert.equal(ignored, true, "ORDINARY_IGNORE_SUCCESS_PRESERVED");
      assert.deepEqual(admissions, [
        { mode: "shared", folders: ["group/private"], holders: 2 },
        { mode: "shared", folders: ["group/private"], holders: 2 },
      ]);
      assert.equal(gate.holders().length, 1);
      assert.equal(existsSync(join(brain, "notes/allowed.md")), true, "PERMITTED_SIBLING_PUBLICATION_CONTINUES");
      peer.stdin.write("go\n"); peer.stdin.end();
      assert.equal(await peer.exited, 0, (await output).join(""));
      assert.equal(existsSync(join(brain, "group/private/peer.md")), true, "ACTIVE_PEER_REMAINS_WRITABLE");
      writeFileSync(join(outputDirectory, "receipt.json"), JSON.stringify({ target, before, after, refusedPublication: true, permittedIgnoreAnswer: ignored, admissions, peerUsable: true }));
    } finally {
      peer?.kill(); if (peer) await peer.exited; await output;
      hold?.release(); db.close(); await service.close();
    }
  }
}

if (import.meta.main) await proveScheduleFolderAdmission("/proof");
