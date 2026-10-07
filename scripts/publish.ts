import { resolve } from "path";

import { assertPublishArtifacts } from "./check-dist.js";
import { assertPublishPins } from "./check-publish-pins.js";
import { publishTemplate } from "./publish-template.js";

const packages = [
  "geo",
  // Ahead of core and ui-server, both of which depend on it: publishing a
  // dependent before its dependency leaves the dependent uninstallable in the
  // window between the two `bun publish` calls.
  "render-template",
  "core",
  // Ahead of ui-sdk, whose `show_block` handler classifies links with the
  // kit's `./links` export (#43), and of ui-react, which renders the kit.
  "ui-kit",
  "ui-sdk",
  "ui-backend-claude",
  "ui-backend-pi",
  "ui-render-puppeteer",
  // Ahead of module-jobs and module-travel, which depend on it.
  "scrape",
  "ui-server",
  "ui-react",
  "module-finance",
  "module-images",
  "module-video",
  "module-jobs",
  "module-speaking",
  "module-travel",
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

/**
 * Wait until every just-published version is served by the registry.
 *
 * Confirmation used to sit between publishes: publish one, wait for the
 * registry to serve it, publish the next. That made a fourteen-package release
 * take as long as fourteen propagation waits, and — worse — spread the
 * publishes out far enough for the npm web-login session to expire midway,
 * which is how 0.36.0 stopped with a 403 on the sixth package. A `bun publish`
 * that exits 0 has already been accepted by the registry, so waiting between
 * publishes bought nothing the exit code had not; the wait only tells us when
 * propagation caught up. Now every publish goes out first, back to back, and
 * one poll over the whole set follows.
 *
 * The poll has no deadline. It used to give up after ~5 minutes, and 0.32.0
 * showed what that buys: a healthy publish took longer than the budget to
 * appear, the run stopped, and the operator was left to confirm by hand and
 * re-run. Nothing after this point depends on speed — only `changeset tag`
 * follows, and it must not run before every version is seen — so the poll
 * keeps asking, backing off to once a minute, until the set is complete.
 * A publish that truly failed cannot reach here (its exit code stopped the
 * run), so a version that never appears is a registry incident, and the
 * progress line names it for the operator to look at.
 */
export async function awaitPublished(
  entries: readonly ReleaseEntry[],
  isLive: (name: string, version: string) => Promise<boolean>,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)
): Promise<void> {
  const delaysMs = [2000, 5000, 10000, 15000, 25000, 30000, 45000, 60000];
  let pending = [...entries];
  let waitedMs = 0;
  for (let round = 0; pending.length > 0; round += 1) {
    if (round > 0) {
      const delay = delaysMs[Math.min(round - 1, delaysMs.length - 1)];
      await sleep(delay);
      waitedMs += delay;
    }
    const still: ReleaseEntry[] = [];
    for (const entry of pending) {
      if (await isLive(entry.name, entry.version)) {
        console.log(`  confirmed on the registry: ${entry.name}@${entry.version}`);
      } else {
        still.push(entry);
      }
    }
    pending = still;
    if (pending.length > 0) {
      const names = pending.map((entry) => `${entry.name}@${entry.version}`).join(", ");
      console.log(`  still propagating after ${Math.round(waitedMs / 1000)}s: ${names}`);
    }
  }
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
  // The publishes go out back to back, still in dependency order, and are
  // confirmed against the registry as one set afterwards (see awaitPublished).
  // Exit codes alone leave the operator with an ambiguous signal: a version can
  // read as 404 either because a publish failed or because it simply has not
  // propagated yet, and during the 0.31.0 release that ambiguity cost an hour
  // of chasing a package that was already on its way. Confirming inside the
  // run collapses the two cases — if the release finishes, every version was
  // seen live.
  const published: ReleaseEntry[] = [];
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
    published.push(step);
  }

  if (published.length > 0) {
    console.log("Confirming the published versions against the registry...");
    await awaitPublished(published, isPublished);
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
  const tagExit = await tag.exited;
  if (tagExit !== 0) process.exit(tagExit);

  // Last, and here rather than in a runbook: the published template repository
  // is what `gh repo create --template` hands a new user, and it has to pin a
  // version the registry already serves. Running it from the release means it
  // runs from the version this release published, not from whatever `main`
  // holds by the time somebody remembers. A failure here leaves the packages
  // published and the tag written — re-run `bun scripts/publish-template.ts`
  // alone, it is idempotent.
  try {
    await publishTemplate();
  } catch (error) {
    console.error(
      `Packages are published and tagged, but the template repository was not ` +
        `updated: ${error instanceof Error ? error.message : error}\n` +
        `Fix the cause and re-run \`bun scripts/publish-template.ts\`.`
    );
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) await main();
