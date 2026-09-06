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
  "ui-react",
  "module-finance",
  "module-images",
  "module-jobs",
  "module-speaking",
];

const root = resolve(import.meta.dir, "..");

// Check every package before publishing any of them, avoiding a partial release
// when a required artifact is missing. The npm name comes from each manifest —
// directory names and package names diverge (core → @schlessera/brain).
const names = new Map<string, string>();
for (const packageDir of packages) {
  const dir = resolve(root, "packages", packageDir);
  const manifest = (await Bun.file(resolve(dir, "package.json")).json()) as {
    name?: string;
  };
  const name = manifest.name ?? packageDir;
  names.set(packageDir, name);
  assertPublishArtifacts(dir, name);
}

// Second pre-flight: verify what `bun publish` will actually write for the
// workspace:* cross-dependencies (the 0.2.0 stale-lockfile failure). The probe
// itself lives in scripts/check-publish-pins.ts, where CI's pack job runs the
// identical check on every PR.
assertPublishPins(root);

/**
 * Confirm the registry actually serves a version, retrying past propagation lag.
 *
 * A just-published version can read as absent for a while: the packument is
 * CDN-cached, and `dist-tags.latest` in particular can lag the version list by
 * minutes. The tarball URL is the earliest honest signal, so ask for that and
 * fall back to the version list; both are cache-busted, because a cached 404
 * would otherwise be indistinguishable from a failed publish.
 */
async function isPublished(name: string, version: string): Promise<boolean> {
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

async function assertPublished(name: string, version: string): Promise<void> {
  // ~90s of patience. Propagation is normally seconds, but it has run to a
  // minute — long enough that an impatient check reads a live package as
  // missing.
  const delaysMs = [0, 2000, 5000, 10000, 15000, 25000, 30000];
  for (const delay of delaysMs) {
    if (delay) await Bun.sleep(delay);
    if (await isPublished(name, version)) return;
  }
  console.error(
    `\nRelease stopped: ${name}@${version} did not appear on the registry within 90s\n` +
      `of publishing it. Nothing after this package was published and no tags were\n` +
      `written, so the release is partial but consistent.\n\n` +
      `To resume: comment out every already-published name in the \`packages\` list\n` +
      `above, re-run \`bun run release\`, and uncomment them afterwards.\n` +
      `Republishing an existing version fails; it does not overwrite.`
  );
  process.exit(1);
}

// The artifact pre-flight above prevents a partial release from missing
// builds, but a mid-run `bun publish` failure (network, 403, name conflict)
// still leaves earlier packages live on npm with `changeset tag` unreached.
// Operator runbook: fix the cause, comment out the already-published names
// in `packages`, and re-run — republishing an existing version fails, it
// does not overwrite.
//
// Each publish is also confirmed against the registry before the next one
// starts. Exit codes alone leave the operator with an ambiguous signal
// afterwards: a version can read as 404 either because a publish failed or
// because it simply has not propagated yet, and during the 0.31.0 release that
// ambiguity cost an hour of chasing a package that was already on its way.
// Confirming inside the run collapses the two cases — if the release finishes,
// every version was seen live.
for (const packageName of packages) {
  const name = names.get(packageName)!;
  console.log(`Publishing ${name}...`);
  const subprocess = Bun.spawn([process.execPath, "publish", "--access", "public"], {
    cwd: resolve(root, "packages", packageName),
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) process.exit(exitCode);

  const manifest = (await Bun.file(
    resolve(root, "packages", packageName, "package.json")
  ).json()) as { version: string };
  await assertPublished(name, manifest.version);
  console.log(`  confirmed on the registry: ${name}@${manifest.version}`);
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
