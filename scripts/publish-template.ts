#!/usr/bin/env bun
/**
 * Publish `template/` to the standalone `schlessera/brain-template` repository.
 *
 * `template/` here is the source of truth; the published repository is
 * generated, never edited. A user gets it through GitHub's "Use this template",
 * which is why three documents already print
 * `gh repo create … --template schlessera/brain-template`
 * (`docs/quickstart.md`, `template/README.md`, `README.md`).
 *
 * Two properties this has to hold, both of them mistakes that were made before
 * the mechanism existed:
 *
 * - **The published template pins a version that is actually on the registry.**
 *   `template/package.json` moved with the release and the published repository
 *   did not, so a newly created brain installed an obsolete core
 *   (`tests/release-manifest.test.ts` guards the pin inside this repo, and
 *   cannot see the other one). This script refuses to publish a pin the
 *   registry does not serve, which is why it belongs at the END of the release
 *   rather than alongside `changeset version`.
 * - **A development-only file never ships.** `README-template-dev.md` is
 *   excluded by this list, not by remembering. The published file list is
 *   asserted against a golden in `tests/release-manifest.test.ts`, so adding
 *   anything to `template/` fails the build until someone decides which side of
 *   the line it is on.
 *
 * History in the published repository is append-only: a template repository's
 * history is what a user's brain inherits on clone, so this commits on top
 * rather than rewriting. Running it twice is a no-op the second time — the
 * second run has nothing to commit and says so.
 */
import { mkdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";

import { isPublished } from "./publish.js";

const ROOT = resolve(import.meta.dir, "..");
const TEMPLATE_DIR = join(ROOT, "template");

export const TEMPLATE_REPO = "schlessera/brain-template";

/**
 * Files under `template/` that are about maintaining the template rather than
 * using a brain. Matched against the path relative to `template/`.
 */
export const TEMPLATE_EXCLUDES = ["README-template-dev.md"];

/** Everything this would publish, relative to `template/`, sorted. */
export async function templateFilesToPublish(dir = TEMPLATE_DIR): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const found: string[] = [];
  for await (const entry of glob.scan({ cwd: dir, dot: true, onlyFiles: true })) {
    found.push(entry);
  }
  return found.filter((f) => !TEMPLATE_EXCLUDES.includes(f)).sort();
}

async function run(
  cmd: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function mustRun(cmd: string[], cwd: string): Promise<string> {
  const { code, stdout, stderr } = await run(cmd, cwd);
  if (code !== 0) {
    throw new Error(`\`${cmd.join(" ")}\` failed with ${code}:\n${stderr || stdout}`);
  }
  return stdout;
}

export interface PublishTemplateOptions {
  repo?: string;
  /** Resolve and report what would happen, touching no remote. */
  dryRun?: boolean;
  /** Skip the registry check. Only for exercising the mechanism itself. */
  allowUnpublished?: boolean;
}

export async function publishTemplate(options: PublishTemplateOptions = {}): Promise<void> {
  const repo = options.repo ?? TEMPLATE_REPO;
  const core = (await Bun.file(join(ROOT, "packages/core/package.json")).json()) as {
    name: string;
    version: string;
  };
  const template = (await Bun.file(join(TEMPLATE_DIR, "package.json")).json()) as {
    dependencies?: Record<string, string>;
  };
  const pin = template.dependencies?.[core.name];
  if (pin !== `^${core.version}`) {
    throw new Error(
      `template/package.json pins ${core.name}@${pin}, but this tree is at ` +
        `${core.version}. Bump the pin (see the release skill) before publishing ` +
        `the template — the published repository is what a user installs.`
    );
  }

  if (!options.allowUnpublished) {
    if (!(await isPublished(core.name, core.version))) {
      throw new Error(
        `${core.name}@${core.version} is not on the registry yet, so \`bun install\` in ` +
          `a clone of ${repo} would fail. Publish the packages first — this step runs ` +
          `at the end of \`bun run release\` for exactly this reason.`
      );
    }
  }

  const files = await templateFilesToPublish();
  console.log(
    `Publishing ${files.length} files from template/ to ${repo} at ${core.version} ` +
      `(excluded: ${TEMPLATE_EXCLUDES.join(", ")})`
  );
  if (options.dryRun) {
    for (const file of files) console.log(`  ${file}`);
    console.log("Dry run: nothing was cloned, committed or pushed.");
    return;
  }

  const work = join(
    process.env.TMPDIR ?? "/tmp",
    `brain-template-publish-${Date.now()}`
  );
  mkdirSync(work, { recursive: true });
  const clone = join(work, "clone");
  try {
    console.log(`Cloning ${repo}...`);
    await mustRun(["git", "clone", `https://github.com/${repo}.git`, clone], work);

    // Delete the whole working tree, then lay the template down: a file removed
    // from template/ has to disappear from the published repository too, and a
    // copy-over-the-top would leave it behind forever.
    for await (const entry of new Bun.Glob("*").scan({
      cwd: clone,
      dot: true,
      onlyFiles: false,
    })) {
      if (entry === ".git") continue;
      rmSync(join(clone, entry), { recursive: true, force: true });
    }
    for (const file of files) {
      const target = join(clone, file);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, Bun.file(join(TEMPLATE_DIR, file)));
    }

    await mustRun(["git", "add", "-A"], clone);
    const status = await mustRun(["git", "status", "--porcelain"], clone);
    if (status.trim() === "") {
      console.log(`${repo} is already at this template. Nothing to publish.`);
      return;
    }
    console.log(status.trimEnd());
    await mustRun(
      ["git", "commit", "-m", `chore: template at ${core.version}`],
      clone
    );
    await mustRun(["git", "push"], clone);
    console.log(`Published template/ to ${repo} at ${core.version}.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const repoFlag = argv.indexOf("--repo");
  await publishTemplate({
    repo: repoFlag === -1 ? undefined : argv[repoFlag + 1],
    dryRun: argv.includes("--dry-run"),
    allowUnpublished: argv.includes("--allow-unpublished"),
  });
}
