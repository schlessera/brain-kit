/**
 * Which repositories one module cron job may read (#3380), decided before the
 * job runs. The runner asks the brain, credential-free, which module owns the
 * job (`brain module list --json`), intersects that module's request with the
 * operator's allow-list, and has the host fetch what both name. The crontab
 * carries no module or repository information.
 */
import type { MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
import { brainCommandClass, type HostBoundary } from "../brain/host-boundary.js";
import { canonicalRepository, fetchModuleRepository, grantModuleRepositories, moduleRepositoryMirrorPath, MODULE_REPOSITORIES_ENV,
  type ModuleRepositoryAccess, type RepositoryTransportRun } from "../brain/module-repositories.js";
import type { BrainModuleListPayload } from "./emit.js";

/**
 * Read the module list through the host boundary, credential-free and gated
 * shared: a maintenance worker while the boundary holds. The same read as the
 * crontab's module discovery, kept separate so a job never depends on it.
 */
export async function readJobModuleList(
  env: Record<string, string | undefined>,
  boundary: HostBoundary
): Promise<BrainModuleListPayload | null> {
  try {
    // The CLI imports the repository's config, so this read goes through the
    // host boundary like every other CLI launch: a maintenance worker while
    // it holds, the exec wrapper otherwise.
    const result = await boundary.run({ argv: ["brain", "module", "list", "--json"], env,
      ...brainCommandClass(["module", "list"]), purpose: "brain module list" });
    const exitCode = result.exitCode;
    const stdout = result.stdout;
    if (exitCode !== 0 || stdout.trim() === "") return null;
    const parsed: unknown = JSON.parse(stdout);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Partial<BrainModuleListPayload>).enabled) ||
      !Array.isArray((parsed as Partial<BrainModuleListPayload>).available)
    ) {
      return null;
    }
    return parsed as BrainModuleListPayload;
  } catch {
    return null;
  }
}

/**
 * The enabled modules whose cron entry the crontab would have emitted as this
 * job: `<module>-<entry>` running `brain <command>`. Names alone are ambiguous,
 * since both parts may contain `-`; the command disambiguates them.
 */
export function modulesForJob(payload: BrainModuleListPayload, jobName: string, command: readonly string[]): BrainModuleListPayload["enabled"] {
  return payload.enabled.filter(module => module && typeof module.name === "string" && Array.isArray(module.cron)
    && module.cron.some(entry => entry && `${module.name}-${entry.name}` === jobName && typeof entry.command === "string"
      && command.length > 1 && command[0] === "brain" && command.slice(1).join(" ") === entry.command.split(/ +/).filter(Boolean).join(" ")));
}

export type JobRepositories =
  | { ok: true; repositories: ModuleRepositoryAccess[]; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

/**
 * Decide and fetch one job's repositories. A job no module owns, or whose
 * module asks for none, runs as before with none. A request the operator has
 * not allowed refuses the job before it starts, naming the repository and the
 * host setting; so does a failed fetch.
 */
export async function prepareJobRepositories(input: {
  jobName: string; command: readonly string[]; brainPath: string; dbPath?: string;
  /** The runner's job environment: the transport's credential comes from here and nowhere else. */
  env: MaintenanceCommand["env"];
  /** The operator allow-list, already parsed from host configuration. */
  allowList: readonly string[];
  listModules: () => Promise<BrainModuleListPayload | null>;
  tempLimits?: MaintenanceCommand["tempLimits"]; tempDomain?: MaintenanceCommand["tempDomain"]; signal?: AbortSignal;
  /** @internal Test seams for the transport and the credential's fixture origin. */
  run?: RepositoryTransportRun; credentialOrigin?: string;
}): Promise<JobRepositories> {
  // Module jobs are always `<module>-<entry>`; a core job never asks.
  if (!input.jobName.includes("-")) return { ok: true, repositories: [], notes: [] };
  const payload = await input.listModules();
  if (!payload) return { ok: true, repositories: [], notes: ["module list unavailable: no repository is fetched for this job"] };
  const owners = modulesForJob(payload, input.jobName, input.command);
  const requested = [...new Set(owners.flatMap(module => Array.isArray(module.repositories) ? module.repositories : []))];
  if (requested.length === 0) return { ok: true, repositories: [], notes: [] };
  if (owners.length > 1) {
    return { ok: false, notes: [], reason: `job ${input.jobName} matches the cron entries of ${owners.map(m => m.name).join(", ")}; no repository is fetched for an ambiguous job` };
  }
  const module = owners[0]!;
  const { granted, refused } = grantModuleRepositories(requested, input.allowList);
  if (refused.length) {
    return { ok: false, notes: [], reason: `module ${module.name} asks for ${refused.join(", ")}, which the host's ${MODULE_REPOSITORIES_ENV} does not allow; `
      + "a repository is fetched for a module job only when the operator's host configuration allows it too. The job did not run." };
  }
  const repositories: ModuleRepositoryAccess[] = [];
  try {
    for (const url of granted) {
      if (!canonicalRepository(url)) throw new Error(`not a fetchable repository: ${url}`);
      repositories.push(await fetchModuleRepository({ brain: input.brainPath, mirror: moduleRepositoryMirrorPath(input.brainPath, input.dbPath, url), url, env: input.env,
        ...(input.tempLimits ? { tempLimits: input.tempLimits } : {}), ...(input.tempDomain ? { tempDomain: input.tempDomain } : {}),
        ...(input.signal ? { signal: input.signal } : {}), ...(input.run ? { run: input.run } : {}),
        ...(input.credentialOrigin ? { credentialOrigin: input.credentialOrigin } : {}) }));
    }
  } catch (error) {
    return { ok: false, notes: [], reason: `${error instanceof Error ? error.message : String(error)}. The job did not run.` };
  }
  return { ok: true, repositories, notes: [] };
}

/** Bind the runner's boundary and configuration to {@link prepareJobRepositories}. */
export function cronJobRepositories(input: { boundary: HostBoundary; dbPath?: string; moduleDiscoveryEnv: Record<string, string | undefined>;
  env: MaintenanceCommand["env"]; allowList: readonly string[] }) {
  return (jobName: string, command: readonly string[]) => prepareJobRepositories({ jobName, command, brainPath: input.boundary.brainPath, dbPath: input.dbPath,
    env: input.env, allowList: input.allowList, listModules: () => readJobModuleList(input.moduleDiscoveryEnv, input.boundary),
    ...(input.boundary.maintenance?.tempLimits ? { tempLimits: input.boundary.maintenance.tempLimits } : {}),
    ...(input.boundary.maintenance?.tempDomain ? { tempDomain: input.boundary.maintenance.tempDomain } : {}) });
}
