/**
 * Preflight for a test-health run: can this checkout audit, and may it land?
 *
 * A failed check that only limits the run (no Docker, a red main) is reported
 * as a capability, not as a refusal, so a scheduled run still does the part it
 * can. Low disk is a refusal: a nearly full volume stalls git mid-write.
 */
import { existsSync, statfsSync } from "node:fs";
import { join } from "node:path";

export interface Check { name: string; ok: boolean; detail: string; blocking: boolean }
export interface Doctor {
  ok: boolean;
  checks: Check[];
  capabilities: { github: boolean; browserRunner: boolean; mayLand: boolean };
}

export interface DoctorProbes {
  bunVersion: string;
  run: (command: string[]) => { exitCode: number; stdout: string };
  disk: (path: string) => { freeBytes: number; totalBytes: number };
  exists: (path: string) => boolean;
}

const MIN_FREE_BYTES = 5 * 1024 ** 3;
const MIN_FREE_SHARE = 0.03;

export function defaultProbes(root: string): DoctorProbes {
  return {
    bunVersion: Bun.version,
    run: command => {
      try {
        const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
        return { exitCode: result.exitCode, stdout: result.stdout.toString() };
      } catch { return { exitCode: 127, stdout: "" }; }
    },
    disk: path => { const stats = statfsSync(path); return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }; },
    exists: existsSync,
  };
}

const atLeast = (version: string, minimum: [number, number, number]): boolean => {
  const parts = version.split(".").map(part => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index++) {
    if ((parts[index] ?? 0) !== minimum[index]) return (parts[index] ?? 0) > minimum[index]!;
  }
  return true;
};

export function doctor(root: string, probes: DoctorProbes = defaultProbes(root), offline = false): Doctor {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string, blocking = true) => { checks.push({ name, ok, detail, blocking }); return ok; };

  check("bun", atLeast(probes.bunVersion, [1, 4, 0]), `Bun ${probes.bunVersion}; the suite needs 1.4.0 or newer`);
  check("git", probes.run(["git", "rev-parse", "--is-inside-work-tree"]).exitCode === 0, "inside a git work tree");
  check("dependencies", probes.exists(join(root, "node_modules", "typescript")), "node_modules is installed (bun install --frozen-lockfile)");
  const disk = probes.disk(root);
  const share = disk.totalBytes ? disk.freeBytes / disk.totalBytes : 0;
  check("disk", disk.freeBytes >= MIN_FREE_BYTES && share >= MIN_FREE_SHARE,
    `${(disk.freeBytes / 1024 ** 3).toFixed(1)} GiB free (${(share * 100).toFixed(1)}%); needs 5 GiB and 3%`);

  const github = offline ? false : check("github", probes.run(["gh", "auth", "status"]).exitCode === 0, "gh is authenticated", false);
  const browserRunner = check("docker", probes.run(["docker", "info", "--format", "{{.ServerVersion}}"]).exitCode === 0,
    "Docker runs the pinned browser image; without it browser tiers are skipped", false);
  let mayLand = false;
  if (github) {
    const status = probes.run(["bun", "scripts/integrate.ts", "main-status", "--json"]);
    let red: boolean | null = null;
    try { red = status.exitCode === 0 ? Boolean((JSON.parse(status.stdout) as { red?: unknown }).red) : null; } catch { red = null; }
    mayLand = check("main", red === false, red === null ? "main status is unknown, so nothing lands this run" : red ? "main is red: audit, but do not land" : "main is green", false);
  }
  return { ok: checks.every(entry => entry.ok || !entry.blocking), checks, capabilities: { github, browserRunner, mayLand } };
}
