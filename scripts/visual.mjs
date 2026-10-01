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
 *   node scripts/visual.mjs --project=ui-react-layout # offline consumer measurements
 *   node scripts/visual.mjs --update           # rewrite the baselines
 *   node scripts/visual.mjs --shard=1/2        # half the files of every project (CI)
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
const shardArg = argv.find((a) => a.startsWith("--shard="));
// Three projects: every story on dark, every story on paper (D32), and the
// curated visual baselines in both themes.
const projects = projectArg ? [projectArg.slice("--project=".length)] : ["storybook", "storybook-light", "visual"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (inside) {
  // Already in the image. Vitest is invoked through its own entry rather than
  // through a package script, because a package script would need bun.
  //
  // One call for every project, not one per project: vitest then spreads the
  // files of all three over every core, where a project at a time left cores
  // idle. `--shard` splits that combined file list, so no shard runs empty.
  const vitest = resolve(REPO, "node_modules/vitest/vitest.mjs");
  const args = ["run", ...projects.map((project) => `--project=${project}`)];
  if (update) args.push("--update");
  if (shardArg) args.push(shardArg);
  process.exit(run(process.execPath, [vitest, ...args], { cwd: resolve(REPO, KIT) }));
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
  // The consumer layout project needs only the in-container Vite server.
  ...(projects.includes("ui-react-layout") ? ["--network=none"] : []),
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
