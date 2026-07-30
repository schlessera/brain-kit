import { resolve } from "path";

import { assertPublishArtifacts } from "./check-dist.js";

const packages = [
  "core",
  "ui-sdk",
  "ui-backend-claude",
  "ui-backend-pi",
  "ui-render-puppeteer",
  "module-finance",
  "module-jobs",
  "module-speaking",
];

const root = resolve(import.meta.dir, "..");

// Check every package before publishing any of them, avoiding a partial release
// when a required artifact is missing.
for (const packageName of packages) {
  assertPublishArtifacts(
    resolve(root, "packages", packageName),
    `@endoxa/${packageName}`
  );
}

for (const packageName of packages) {
  console.log(`Publishing @endoxa/${packageName}...`);
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
