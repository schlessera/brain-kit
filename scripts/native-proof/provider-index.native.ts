/** Provider-folder admission on real Btrfs, including the strict output keeper. */
import { expect } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { launchAgentWorker, workerCommand } from "../../packages/ui-sdk/src/server/worker-launcher.js";
import { prepareNativeWorkerOutput } from "../../packages/ui-sdk/src/server/worker-native-output.js";
import { createGovernedTurns } from "../../packages/ui-server/src/brain/governed-turn.js";
import { createProviderExposures } from "../../packages/ui-server/src/brain/provider-exposure.js";
import { createHostExecution } from "../../packages/ui-server/src/brain/host-execution.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { openDatabase } from "../../packages/core/src/lib/db.js";

const sentinel = "Zakynthosmarker", permitted = "Phaeacianmarker";
const MIB = 1024 ** 2;
const document = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n${body}\n`;
const text = (stream: Readable) => new Response(Readable.toWeb(stream) as unknown as ReadableStream).text();

export async function proveNativeProviderIndex(brain: string, manager: ReturnType<typeof createNativeBrainManagerClient>): Promise<void> {
  expect(process.getuid?.(), "NATIVE_PROVIDER_INDEX_SERVER_UID").toBe(21001);
  // This case owns these inputs and removes them before the pre-existing
  // identity/journal and ordinary application phases continue.
  for (const rel of ["me", "context", ".git", ".gitignore", ".brain-index"])
    expect(existsSync(join(brain, rel)), `NATIVE_PROVIDER_INDEX_FIXTURE_OWNS_${rel}`).toBe(false);
  mkdirSync(join(brain, "me")); mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "me/oath.md"), document("Odysseus private oath", sentinel));
  writeFileSync(join(brain, "notes/provider-voyage.md"), document("Odysseus permitted voyage", permitted));
  writeFileSync(join(brain, "context/policies/governance.md"),
    "---\nschema_version: 1\nproviders: [{ paths: [me/**], allow: [anthropic] }]\n---\nOdysseus keeps his oath with one provider.\n");
  try {
    writeFileSync(join(brain, ".gitignore"), ".brain/scratch/\n.brain-index/\n");
    const git = Bun.spawnSync(["/usr/bin/git", "init", "--shared=group", "-q", brain],
      { env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
    expect(git.exitCode, git.stderr.toString()).toBe(0);
    const real = Bun.spawnSync([process.execPath, "/repo/packages/core/src/cli/brain.ts", "index", "--json"],
      { cwd: brain, env: { PATH: "/usr/local/bin:/usr/bin:/bin", BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(real.exitCode, real.stderr.toString()).toBe(0);
    const realIndex = () => openDatabase(join(brain, ".brain-index/brain.db"), { readonly: true });
    const initial = realIndex();
    try { expect(initial.query("SELECT path FROM documents WHERE content LIKE ?").all(`%${sentinel}%`),
      "NATIVE_REAL_INDEX_POSITIVE_SENTINEL_CONTROL").toEqual([{ path: "me/oath.md" }]); }
    finally { initial.close(); }
    for (const profile of ["strict", "governed"] as const) {
      const root = `/identity-fixture/provider-index-${profile}`;
      mkdirSync(root, { mode: 0o700 });
      const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
      const reports: string[] = [];
      const execution = createHostExecution({ brainPath: brain, dbPath, nativeManager: manager, profile, requireGate: true });
      execution.attach(db);
      const turns = createGovernedTurns({ nativeManager: manager, brainPath: brain, execution, profile, maskPaths: [],
        index: async () => {}, report: message => reports.push(message),
        privateIndexCommand: [process.execPath, "/repo/packages/core/src/cli/brain.ts"] });
      let hold: Awaited<ReturnType<typeof turns.begin>> | undefined;
      let prepared: Awaited<ReturnType<typeof prepareNativeWorkerOutput>> | undefined;
      let privateIndex: string | undefined;
      try {
        hold = await turns.begin(`native-private-index-${profile}`, new AbortController().signal);
        expect(hold.managedStorage, "NATIVE_PROVIDER_INDEX_MANAGED_ADMISSION").toBe(true);
        expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe(profile);
        expect(hold.sandbox.providerMasks?.folders, "NATIVE_PROVIDER_INDEX_POLICY_APPLIED").toEqual(["me"]);
        const scratch = hold.sandbox.areas.find(area => area.name === "scratch")?.mount;
        expect(scratch?.writable, `NATIVE_PROVIDER_INDEX_WRITABLE_SCRATCH: ${JSON.stringify(scratch)}`).toBe(true);
        privateIndex = hold.sandbox.providerMasks!.index!;
        const info = statSync(privateIndex);
        // The worker's user namespace deliberately does not map the server UID.
        expect(info.uid, "NATIVE_PRIVATE_INDEX_SERVER_OWNER").toBe(21001);
        expect(info.gid, "NATIVE_PRIVATE_INDEX_SHARED_GROUP_OWNER").toBe(21001);
        if (profile === "strict") {
          expect(hold.startupView, "NATIVE_STRICT_PROVIDER_INDEX_SEALED_VIEW").toBeDefined();
          prepared = await prepareNativeWorkerOutput(brain, { startupView: hold.startupView!,
            areas: hold.sandbox.areas.filter(area => area.mount.writable).map(area => area.rel), folderPaths: hold.sandbox.retainedFolders });
          const storage = prepared.output.storage;
          expect(storage.identityTicketFd, "NATIVE_STRICT_PROVIDER_INDEX_SEPARATE_UID_STAGE").toBeGreaterThan(2);
          const command = workerCommand({ brainPath: brain, startupView: prepared.view, sandbox: hold.sandbox,
            areaOutput: prepared.output, env: {}, command: ["/bin/true"] });
          expect(command, "NATIVE_STRICT_PROVIDER_INDEX_KEEPER_NAMESPACE").toContain(Bun.which("nsenter")!);
          expect(command, "NATIVE_STRICT_PROVIDER_INDEX_KEEPER_PID").toContain(String(storage.namespacePid));
        } else expect(hold.startupView, "NATIVE_GOVERNED_PROVIDER_INDEX_LIVE_BRAIN").toBeUndefined();
        const launch = { brainPath: brain, sandbox: hold.sandbox,
          ...(prepared ? { startupView: prepared.view, preparedOutput: prepared } : {}), stateBytes: MIB, turnTempBytes: 16 * MIB,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin", BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" },
          command: [process.execPath, "/repo/scripts/native-proof/provider-index-worker.ts", profile, `${info.dev}:${info.ino}`] };
        const result = await (async () => {
          const worker = launchAgentWorker(launch), timer = setTimeout(() => worker.kill("SIGKILL"), 30_000);
          worker.stdin.end();
          const stdout = text(worker.stdout), stderr = text(worker.stderr);
          let code: number;
          try {
            code = await worker.exited;
          } finally { clearTimeout(timer); worker.state?.close(); worker.turnTemp?.close(); }
          return { code, stdout: await stdout, stderr: await stderr };
        })().catch(error => ({ code: -1, stdout: "", stderr: String(error) }));
        expect(result.code, `NATIVE_${profile.toUpperCase()}_PRIVATE_INDEX_MOUNTED: ${result.stderr}`).toBe(0);
        expect(result.stdout, "NATIVE_PROVIDER_INDEX_WORKER_COMPLETED").toContain('"nativeProviderIndexWorker":"pass"');
        expect(reports.filter(report => report.includes("private search index")), "NATIVE_PROVIDER_INDEX_BUILD_COMPLETE").toEqual([]);
        const capturePath = `native-private-index-${profile}.md`;
        expect(readFileSync(join(brain, ".brain/scratch", `provider-index-${profile}`, capturePath), "utf8"),
          "NATIVE_PRIVATE_INDEX_CAPTURE_MARKDOWN_PUBLISHED").toContain("Ithacacapturemarker");
        const original = realIndex();
        try {
          expect(original.query("SELECT path FROM documents WHERE content LIKE ?").all(`%${sentinel}%`),
            "NATIVE_REAL_INDEX_STILL_HOLDS_SENTINEL").toEqual([{ path: "me/oath.md" }]);
          expect(original.query("SELECT path FROM documents WHERE path = ?").all(capturePath),
            "NATIVE_CAPTURE_WRITES_PRIVATE_INDEX_ONLY").toEqual([]);
        } finally { original.close(); }
        console.log(JSON.stringify({ nativeProviderIndex: "pass", profile, serverUid: process.getuid?.(), workerUid: 21002,
          keeperNamespace: prepared?.output.storage.namespacePid ?? null, capture: "core-ingestion-in-writable-scratch" }));
      } finally {
        try { await prepared?.cleanup(); } finally {
          try { await hold?.end(); } finally { await turns.close(); execution.release(); db.close(); }
        }
      }
      expect(privateIndex && existsSync(privateIndex), "NATIVE_PRIVATE_INDEX_REMOVED_AFTER_TURN").toBe(false);
    }
    // The allowed route (#2695): a turn whose relay reaches Anthropic's own
    // origin sees the folder, `.git` and the real index on managed storage,
    // through the separate-UID launch and its pre-payload qualification.
    for (const profile of ["strict", "governed"] as const) {
      const root = `/identity-fixture/provider-allowed-${profile}`;
      mkdirSync(root, { mode: 0o700 });
      const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
      const execution = createHostExecution({ brainPath: brain, dbPath, nativeManager: manager, profile, requireGate: true });
      execution.attach(db);
      const turns = createGovernedTurns({ nativeManager: manager, brainPath: brain, execution, profile, maskPaths: [],
        index: async () => {}, report: () => {}, privateIndexCommand: [process.execPath, "/repo/packages/core/src/cli/brain.ts"],
        exposures: createProviderExposures(db) });
      let hold: Awaited<ReturnType<typeof turns.begin>> | undefined;
      let prepared: Awaited<ReturnType<typeof prepareNativeWorkerOutput>> | undefined;
      try {
        hold = await turns.begin(`native-provider-allowed-${profile}`, new AbortController().signal, "interactive", undefined,
          { inferenceOrigin: "https://api.anthropic.com" });
        expect(hold.managedStorage, "NATIVE_ALLOWED_ROUTE_MANAGED_ADMISSION").toBe(true);
        expect(hold.sandbox.profile, hold.sandbox.fallbackReason).toBe(profile);
        expect(hold.sandbox.inferenceRecipient, "NATIVE_ALLOWED_ROUTE_RECIPIENT").toEqual({ name: "anthropic", origin: "https://api.anthropic.com" });
        expect(hold.sandbox.providerMasks, "NATIVE_ALLOWED_ROUTE_NO_FOLDER_MASK").toEqual({ folders: [] });
        if (profile === "strict") {
          prepared = await prepareNativeWorkerOutput(brain, { startupView: hold.startupView!,
            areas: hold.sandbox.areas.filter(area => area.mount.writable).map(area => area.rel), folderPaths: hold.sandbox.retainedFolders });
        }
        // A governed worker binds the live brain, so its real index is this directory; a strict one sees the checkpoint's.
        const index = profile === "governed" ? (({ dev, ino }) => `${dev}:${ino}`)(statSync(join(brain, ".brain-index"))) : "checkpoint";
        const worker = launchAgentWorker({ brainPath: brain, sandbox: hold.sandbox,
          ...(prepared ? { startupView: prepared.view, preparedOutput: prepared } : {}), stateBytes: MIB, turnTempBytes: 16 * MIB,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin", BRAIN_ROOT: brain, HOME: "/tmp", NO_COLOR: "1" },
          command: [process.execPath, "/repo/scripts/native-proof/provider-index-worker.ts", profile, index, "allowed"] });
        const timer = setTimeout(() => worker.kill("SIGKILL"), 30_000);
        worker.stdin.end();
        const stdout = text(worker.stdout), stderr = text(worker.stderr);
        let code: number;
        try { code = await worker.exited; } finally { clearTimeout(timer); worker.state?.close(); worker.turnTemp?.close(); }
        expect(code, `NATIVE_${profile.toUpperCase()}_ALLOWED_ROUTE_LAUNCHED: ${await stderr}`).toBe(0);
        expect(await stdout, "NATIVE_ALLOWED_ROUTE_WORKER_COMPLETED").toContain('"nativeProviderAllowedWorker":"pass"');
        console.log(JSON.stringify({ nativeProviderAllowed: "pass", profile }));
      } finally {
        try { await prepared?.cleanup(); } finally {
          try { await hold?.end(); } finally { await turns.close(); execution.release(); db.close(); }
        }
      }
    }
    // A hardlink out of the masked folder (#2700): the managed Btrfs
    // checkpoint keeps it, so admission must refuse it by name. A governed
    // turn falls back to that checkpoint because the retained folder now
    // holds a multiply linked file.
    linkSync(join(brain, "me/oath.md"), join(brain, "notes/oath-alias.txt"));
    for (const profile of ["strict", "governed"] as const) {
      const root = `/identity-fixture/provider-hardlink-${profile}`;
      mkdirSync(root, { mode: 0o700 });
      const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
      const execution = createHostExecution({ brainPath: brain, dbPath, nativeManager: manager, profile, requireGate: true });
      execution.attach(db);
      const turns = createGovernedTurns({ nativeManager: manager, brainPath: brain, execution, profile, maskPaths: [],
        index: async () => {}, report: () => {}, privateIndexCommand: [process.execPath, "/repo/packages/core/src/cli/brain.ts"] });
      let refusal: unknown;
      try {
        try { await (await turns.begin(`native-provider-hardlink-${profile}`, new AbortController().signal)).end(); }
        catch (error) { refusal = error; }
      } finally { await turns.close(); execution.release(); db.close(); }
      expect((refusal as Error | undefined)?.name, `NATIVE_PROVIDER_HARDLINK_REFUSED_${profile.toUpperCase()}: ${String(refusal)}`).toBe("ProviderPolicyRefusedError");
      expect((refusal as Error).message, "NATIVE_PROVIDER_HARDLINK_NAMED").toContain("notes/oath-alias.txt is a hardlink to me/oath.md");
      console.log(JSON.stringify({ nativeProviderHardlink: "refused", profile }));
    }
  } finally {
    for (const rel of ["me", "context", ".git", ".gitignore", ".brain-index", "notes/provider-voyage.md", "notes/oath-alias.txt",
      ".brain/scratch/provider-index-strict", ".brain/scratch/provider-index-governed"])
      rmSync(join(brain, rel), { recursive: true, force: true });
  }
}
