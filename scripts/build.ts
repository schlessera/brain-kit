import { resolve } from "path";
import { executeBuild } from "./build-execution";
import { selectBuildPackages } from "./publishable-packages.ts";
import { advanceOutputGeneration, ensureWorkspaceLease } from "./workspace-lease.mjs";

// Build order is not load-bearing: each package's tsconfig.build.json extends
// the root tsconfig, whose customConditions ["bun"] resolve cross-package
// imports to the sibling's src/, never to emitted .d.ts. What consumers get
// from dist is checked separately, after this script, by
// scripts/check-dist-types.ts. The packages come from their manifests, in the
// same dependency-first order the release publishes them
// (scripts/publishable-packages.ts), so a future resolution change fails
// loudly instead of subtly.
//
//   bun scripts/build.ts [--for <dir>[,<dir>…]] [--jobs=1|2] [--force] [--dry-run [root]]
//
// --for includes each named package and its forward workspace dependencies.
// --dry-run prints that order without building or removing anything.
// --jobs=2 opts a single CI workspace into bounded dependency-level builds.
// The default stays serial, including two concurrent private unit workspaces.
//
// Rebuild every selected package. Persistent reuse is unavailable until effective
// configuration, installed producers and runtime inputs are qualified (#2319).
// --force remains accepted; ordinary builds already follow the same safe path.
const args = process.argv.slice(2);
let dryRun = false, force = false, dryRoot: string | undefined, directories: string[] | undefined;
let jobs = 1, jobsSeen = false;
let packages: ReturnType<typeof selectBuildPackages>;
let root: string;
try {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg === "--force" && !force) force = true;
    else if (/^--jobs=[12]$/.test(arg) && !jobsSeen) { jobs = Number(arg.slice(7)); jobsSeen = true; }
    else if (arg === "--for" && directories === undefined) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--for requires comma-separated package directories");
      directories = value.split(",");
    } else if (!arg.startsWith("--") && dryRoot === undefined) dryRoot = arg;
    else throw new Error(`Unexpected build argument: ${arg}`);
  }
  if (dryRoot !== undefined && !dryRun) throw new Error("A root argument is accepted only with --dry-run");
  root = resolve(dryRoot ?? resolve(import.meta.dir, ".."));
  packages = selectBuildPackages(root, directories);
} catch (error) {
  console.error(`Build failed: ${(error as Error).message}`);
  process.exit(1);
}
if (dryRun) {
  for (const { dir } of packages) console.log(`Would build packages/${dir}`);
  process.exit(0);
}

const coordinated = await ensureWorkspaceLease(root, "write");
if (coordinated !== undefined) process.exit(coordinated);
// Revoke any live invocation's build before the first output mutation, so a
// failed or cancelled build here cannot leave an outer receipt describing dist.
const generation = advanceOutputGeneration(root);
// Intent requests this one operation; its independent qualification and actual
// captured input/output checks supply authority. Unqualified contexts rebuild.
if (process.env.BRAIN_CI_BUILD_OPERATION === "isolated-v1") {
  const { attemptCiBuild } = await import("./ci-build-operation");
  const code = await attemptCiBuild(root, { directories, jobs: jobs as 1 | 2, force });
  if (code !== undefined) process.exit(code);
}
process.exitCode = await executeBuild(root, packages, jobs as 1 | 2, directories !== undefined, generation);
