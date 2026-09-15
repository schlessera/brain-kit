import { resolve } from "path";

import { assertPublishArtifacts } from "./check-dist.js";
import { assertPublishPins } from "./check-publish-pins.js";

const packages = [
  // Ahead of core and ui-server, both of which depend on it: publishing a
  // dependent before its dependency leaves the dependent uninstallable in the
  // window between the two `bun publish` calls.
  "render-template",
  "core",
  "ui-sdk",
  "ui-backend-claude",
  "ui-backend-pi",
  "ui-render-puppeteer",
  // Ahead of module-jobs, which depends on it.
  "scrape",
  "ui-server",
  // Ahead of ui-react, which consumes the kit from step 2 onward.
  "ui-kit",
  "ui-react",
  "module-finance",
  "module-images",
  "module-jobs",
  "module-speaking",
];

const root = resolve(import.meta.dir, "..");

/**
 * Confirm the registry actually serves a version, retrying past propagation lag.
 *
 * A just-published version can read as absent for a while: the packument is
 * CDN-cached, and `dist-tags.latest` in particular can lag the version list by
 * minutes. The tarball URL is the earliest honest signal, so ask for that and
 * fall back to the version list; both are cache-busted, because a cached 404
 * would otherwise be indistinguishable from a failed publish.
 */
export async function isPublished(name: string, version: string): Promise<boolean> {
  const bare = name.replace(/^@[^/]+\//, "");
  const scope = name.replace(/\/.*$/, "");
  const bust = `cb=${Date.now()}${Math.random().toString(36).slice(2)}`;
  const headers = { "cache-control": "no-cache" };
  try {
    const tarball = await fetch(
      `https://registry.npmjs.org/${name}/-/${bare}-${version}.tgz?${bust}`,
      { method: "HEAD", headers }
    );
    if (tarball.ok) return true;
  } catch {
    // Network blip: fall through to the packument, then to another attempt.
  }
  try {
    const encoded = `${encodeURIComponent(scope)}%2f${bare}`;
    const res = await fetch(`https://registry.npmjs.org/${encoded}?${bust}`, { headers });
    if (!res.ok) return false;
    const doc = (await res.json()) as { versions?: Record<string, unknown> };
    return Boolean(doc.versions?.[version]);
  } catch {
    return false;
  }
}

export interface ReleaseEntry {
  dir: string;
  name: string;
  version: string;
}

export interface ReleaseStep extends ReleaseEntry {
  action: "publish" | "skip";
}

/**
 * Decide what is left to do, so a partial release is finished by re-running it.
 *
 * npm refuses to publish over an existing version, so a resumed release used to
 * die with a 403 on the first package the previous run got out — the operator
 * had to comment names out of the list above by hand and remember to restore
 * them. Asking the registry first makes the run idempotent instead: whatever is
 * already live is skipped, and only the tail still publishes. The 0.32.0 release
 * needed exactly this (five packages live, the sixth's confirmation timed out).
 *
 * Order is preserved and the probes run in sequence, because the list is
 * ordered dependency-first and a skipped entry must not let a dependent jump
 * ahead of a dependency that still has to go out.
 */
export async function planRelease(
  entries: readonly ReleaseEntry[],
  isLive: (name: string, version: string) => Promise<boolean>
): Promise<ReleaseStep[]> {
  const plan: ReleaseStep[] = [];
  for (const entry of entries) {
    plan.push({ ...entry, action: (await isLive(entry.name, entry.version)) ? "skip" : "publish" });
  }
  return plan;
}

async function assertPublished(name: string, version: string): Promise<void> {
  // ~5 minutes of patience. Propagation is normally seconds, but during the
  // 0.32.0 release it ran past 90s on a package that had in fact published —
  // and the impatient check turned a healthy release into a stopped one.
  const delaysMs = [0, 2000, 5000, 10000, 15000, 25000, 30000, 45000, 60000, 60000, 60000];
  for (const delay of delaysMs) {
    if (delay) await Bun.sleep(delay);
    if (await isPublished(name, version)) return;
  }
  console.error(
    `\nRelease stopped: ${name}@${version} did not appear on the registry within\n` +
      `5 minutes of publishing it. The publish itself most likely SUCCEEDED and is\n` +
      `still propagating — check https://www.npmjs.com/package/${name} before\n` +
      `concluding otherwise. Nothing after this package was published and no tags\n` +
      `were written, so the release is partial but consistent.\n\n` +
      `To resume: re-run \`bun run release\`. Every version already on the registry\n` +
      `is skipped automatically, so the run continues where this one stopped.`
  );
  process.exit(1);
}

async function main(): Promise<void> {
  // Check every package before publishing any of them, avoiding a partial
  // release when a required artifact is missing. The npm name comes from each
  // manifest — directory names and package names diverge (core →
  // @schlessera/brain).
  const entries: ReleaseEntry[] = [];
  for (const packageDir of packages) {
    const dir = resolve(root, "packages", packageDir);
    const manifest = (await Bun.file(resolve(dir, "package.json")).json()) as {
      name?: string;
      version: string;
    };
    const name = manifest.name ?? packageDir;
    entries.push({ dir: packageDir, name, version: manifest.version });
    assertPublishArtifacts(dir, name);
  }

  // Second pre-flight: verify what `bun publish` will actually write for the
  // workspace:* cross-dependencies (the 0.2.0 stale-lockfile failure). The probe
  // itself lives in scripts/check-publish-pins.ts, where CI's pack job runs the
  // identical check on every PR.
  assertPublishPins(root);

  // Third pre-flight: ask the registry what is already out. A first release of
  // a version skips nothing; a resumed one skips exactly the packages the
  // previous run got out.
  console.log("Checking which versions are already on the registry...");
  const plan = await planRelease(entries, isPublished);
  const pending = plan.filter((step) => step.action === "publish");
  const skipped = plan.filter((step) => step.action === "skip");
  if (skipped.length > 0) {
    console.log(
      `Resuming a partial release: ${skipped.length} of ${plan.length} packages are ` +
        `already live, ${pending.length} still to publish.`
    );
  }

  // The artifact pre-flight above prevents a partial release from missing
  // builds, but a mid-run `bun publish` failure (network, 403, name conflict)
  // still leaves earlier packages live on npm with `changeset tag` unreached.
  // Operator runbook: fix the cause and re-run — the plan above skips whatever
  // already made it out, and republishing an existing version fails rather
  // than overwriting.
  //
  // Each publish is also confirmed against the registry before the next one
  // starts. Exit codes alone leave the operator with an ambiguous signal
  // afterwards: a version can read as 404 either because a publish failed or
  // because it simply has not propagated yet, and during the 0.31.0 release that
  // ambiguity cost an hour of chasing a package that was already on its way.
  // Confirming inside the run collapses the two cases — if the release finishes,
  // every version was seen live.
  for (const step of plan) {
    if (step.action === "skip") {
      console.log(`Already on the registry, skipping ${step.name}@${step.version}`);
      continue;
    }
    console.log(`Publishing ${step.name}...`);
    const subprocess = Bun.spawn([process.execPath, "publish", "--access", "public"], {
      cwd: resolve(root, "packages", step.dir),
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await subprocess.exited;
    if (exitCode !== 0) process.exit(exitCode);

    await assertPublished(step.name, step.version);
    console.log(`  confirmed on the registry: ${step.name}@${step.version}`);
  }

  const bunx = Bun.which("bunx");
  if (!bunx) {
    console.error(
      "Release failed after publishing packages: could not find `bunx` to run `changeset tag`."
    );
    process.exit(1);
  }

  console.log("Tagging the release with Changesets...");
  const tag = Bun.spawn([bunx, "changeset", "tag"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await tag.exited);
}

if (import.meta.main) await main();
