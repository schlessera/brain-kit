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

// The artifact pre-flight above prevents a partial release from missing
// builds, but a mid-run `bun publish` failure (network, 403, name conflict)
// still leaves earlier packages live on npm with `changeset tag` unreached.
// Operator runbook: fix the cause, comment out the already-published names
// in `packages`, and re-run — republishing an existing version fails, it
// does not overwrite.
for (const packageName of packages) {
  console.log(`Publishing ${names.get(packageName)}...`);
  const subprocess = Bun.spawn([process.execPath, "publish", "--access", "public"], {
    cwd: resolve(root, "packages", packageName),
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) process.exit(exitCode);
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
