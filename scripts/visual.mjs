#!/usr/bin/env node
/**
 * Runs `packages/ui-kit`'s browser test projects inside the pinned Playwright
 * image — the storybook project (interaction + accessibility) and the visual
 * project (screenshot baselines).
 *
 * ## Why the container, and why it is not optional
 *
 * D10: baselines are named `-chromium-linux.png` and browser rendering is not
 * reproducible across environments, so generation and comparison must happen in
 * the same one. That is not a precaution taken in advance — a host-generated
 * baseline compared inside the container did not merely differ, it hung the
 * matcher until the test timed out, so the failure did not even look like a
 * visual diff.
 *
 * ## Why one file rather than a local command and a CI step
 *
 * Because those drift, and a visual suite that drifts from what CI runs is
 * worse than none: it fails locally for reasons nobody can reproduce. Locally
 * this script starts the container; in CI the job already runs inside the same
 * image and calls this script with `--inside`. Both paths reach the identical
 * vitest invocation, which is the point.
 *
 * ## Why `.mjs` when every other script in this repo is TypeScript run by bun
 *
 * The Playwright image has node and no bun, and putting bun into it on every
 * run would make the image's own pin a lie about what produced the pixels. This
 * file is the one place in the repo that has to run under both, so it is plain
 * node ESM that bun also runs unchanged.
 *
 * Usage:
 *   node scripts/visual.mjs                    # both projects, in the container
 *   node scripts/visual.mjs --project=visual   # one project
 *   node scripts/visual.mjs --update           # rewrite the baselines
 *   node scripts/visual.mjs --inside …         # already in the image (CI)
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The pin. Must equal the `playwright` devDependency in `packages/ui-kit`, the
 * `container:` image in `.github/workflows/ci.yml`, and D10. */
const IMAGE = "mcr.microsoft.com/playwright:v1.63.0-noble";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KIT = "packages/ui-kit";

const argv = process.argv.slice(2);
const inside = argv.includes("--inside");
const update = argv.includes("--update");
const projectArg = argv.find((a) => a.startsWith("--project="));
const projects = projectArg ? [projectArg.slice("--project=".length)] : ["storybook", "visual"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (inside) {
  // Already in the image. Vitest is invoked through its own entry rather than
  // through a package script, because a package script would need bun.
  const vitest = resolve(REPO, "node_modules/vitest/vitest.mjs");
  for (const project of projects) {
    const args = ["run", `--project=${project}`];
    if (update) args.push("--update");
    const status = run(process.execPath, [vitest, ...args], { cwd: resolve(REPO, KIT) });
    if (status !== 0) process.exit(status);
  }
  process.exit(0);
}

// Local. `--ipc=host` because Chromium's default 64MB /dev/shm makes it crash
// on a large page in ways that look like a flaky test. `--user` because a
// container running as root writes root-owned baselines into the working tree,
// which the next `rm` then cannot remove.
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const gid = typeof process.getgid === "function" ? process.getgid() : 0;

const status = run("docker", [
  "run",
  "--rm",
  "--ipc=host",
  "--user",
  `${uid}:${gid}`,
  "-v",
  `${REPO}:/repo`,
  "-w",
  "/repo",
  "-e",
  "HOME=/tmp",
  IMAGE,
  "node",
  "scripts/visual.mjs",
  "--inside",
  ...argv.filter((a) => a !== "--inside"),
]);

process.exit(status);
