/** Dependency installation is an isolated host-maintenance action, never a host evaluation. */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectModuleGenerations, currentModuleGeneration, hasManagedNativeStorage, moduleLockHash, moduleStorePath, publishModuleGeneration,
  runMaintenanceWorker, type MaintenanceCommand, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";

/** Match the CLI command position, never a search/query argument named maintain. */
export function moduleMaintenanceRequested(argv: readonly string[]): boolean {
  const program = argv[0]?.split("/").at(-1);
  if (program === "brain") return argv[1] === "maintain";
  if (program !== "bun" && argv[0] !== process.execPath) return false;
  return (/^(?:brain|brain-cli)\.[cm]?[jt]s$/.test(argv[1]?.split("/").at(-1) ?? "") && argv[2] === "maintain")
    || (argv[1] === "run" && argv[2] === "brain" && argv[3] === "maintain");
}
export interface ModuleMaintenanceResult { result: "unchanged" | "activated" | "failed" | "unmanaged"; generation?: string; lockHash?: string; trigger: string; detail?: string }
/** Concrete worker launch permits offline installer probes without a new extension interface. */
export const moduleMaintenanceExecution = { run: runMaintenanceWorker };
export async function maintainModuleStore(brain: string, view: WorkerStartupView, command: MaintenanceCommand, trigger: string): Promise<ModuleMaintenanceResult> {
  if (!hasManagedNativeStorage(brain)) return { result: "unmanaged", trigger };
  let generation: string | undefined, activated = false;
  try {
    const lock = join(view.root, "bun.lock"), manifest = join(view.root, "package.json");
    for (const path of [manifest, lock]) {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error("Module manifests must be tracked regular unaliased files");
    }
    // Git evaluates repository input only inside the maintenance boundary.
    const tracked = await moduleMaintenanceExecution.run({ ...command, startupView: view, credentials: false, network: false,
      command: ["/usr/bin/git", "ls-files", "--error-unmatch", "--", "package.json", "bun.lock"], output: undefined, git: undefined,
      timeoutMs: 30_000 });
    if (tracked.exitCode !== 0 || tracked.killed) throw Error("Module installation requires tracked package.json and bun.lock: " + tracked.stderr);
    const lockBytes = readFileSync(lock), manifestBytes = readFileSync(manifest), lockHash = moduleLockHash(lockBytes);
    const current = currentModuleGeneration(brain);
    if (current?.lockHash === lockHash) {
      collectModuleGenerations(brain); return { result: "unchanged", generation: current.generation, lockHash, trigger };
    }
    generation = randomUUID();
    const root = join(moduleStorePath(brain), generation);
    mkdirSync(root, { mode: 0o755 });
    writeFileSync(join(root, "package.json"), manifestBytes, { flag: "wx", mode: 0o644 });
    writeFileSync(join(root, "bun.lock"), lockBytes, { flag: "wx", mode: 0o644 });
    // No host HOME or secrets. Scripts retain the existing maintenance right
    // to run, inside an isolated worker with just this generation writable.
    const installer = { ...command, startupView: view, output: undefined, git: undefined, credentials: true, network: true,
      env: { PATH: command.env.PATH }, home: undefined, providerRelay: undefined, maskEnvFiles: true, writeFiles: undefined,
      writeDirectories: [root], timeoutMs: 600_000 };
    const built = await moduleMaintenanceExecution.run({ ...installer,
      command: [process.execPath, "--config=/dev/null", "--no-env-file", "install", "--cwd", root, "--frozen-lockfile", "--backend=copyfile"] });
    if (built.exitCode !== 0 || built.killed) throw Error("Module generation install failed: " + built.stderr);
    if (!readFileSync(join(root, "bun.lock")).equals(lockBytes) || !readFileSync(join(root, "package.json")).equals(manifestBytes)) throw Error("Module install changed its tracked input manifests");
    const validation = await moduleMaintenanceExecution.run({ ...installer, network: false,
      command: [process.execPath, "--config=/dev/null", "--no-env-file", join(root, "node_modules/.bin/brain"), "--version"] });
    if (validation.exitCode !== 0 || validation.killed) throw Error("Module generation CLI validation failed: " + validation.stderr);
    publishModuleGeneration(brain, { generation, lockHash, trigger, installedAt: new Date().toISOString() });
    activated = true;
    // Collection is a later pass: do not let cleanup disguise publication.
    return { result: "activated", generation, lockHash, trigger };
  } catch (error) {
    return { result: "failed", trigger, detail: String(error) };
  } finally {
    if (generation && !activated) rmSync(join(moduleStorePath(brain), generation), { recursive: true, force: true });
  }
}
