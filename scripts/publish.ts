import { resolve } from "path";

import { assertPublishArtifacts } from "./check-dist.js";

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
// workspace:* cross-dependencies. bun resolves them from the INSTALLED
// workspace state, so a `changeset version` bump without a fresh `bun install`
// publishes manifests pinning the PREVIOUS version — which was never
// published, making the package uninstallable (this shipped in 0.2.0).
// Pack each package that has internal deps and assert the pins match the
// current workspace versions.
const versions = new Map<string, string>();
for (const packageDir of packages) {
  const manifest = (await Bun.file(
    resolve(root, "packages", packageDir, "package.json")
  ).json()) as { name: string; version: string };
  versions.set(manifest.name, manifest.version);
}
for (const packageDir of packages) {
  const dir = resolve(root, "packages", packageDir);
  const manifest = (await Bun.file(resolve(dir, "package.json")).json()) as {
    name: string;
    dependencies?: Record<string, string>;
  };
  const internal = Object.keys(manifest.dependencies ?? {}).filter((d) =>
    versions.has(d)
  );
  if (internal.length === 0) continue;
  const tarball = resolve(root, "node_modules", ".pin-probe.tgz");
  const pack = Bun.spawnSync(
    [process.execPath, "pm", "pack", "--filename", tarball],
    { cwd: dir }
  );
  if (pack.exitCode !== 0) {
    console.error(`Pin probe failed: could not pack ${manifest.name}`);
    process.exit(1);
  }
  const tar = Bun.spawnSync(["tar", "-xzOf", tarball, "package/package.json"]);
  const packed = JSON.parse(new TextDecoder().decode(tar.stdout)) as {
    dependencies?: Record<string, string>;
  };
  for (const dep of internal) {
    const pinned = packed.dependencies?.[dep];
    const expected = versions.get(dep);
    if (pinned !== expected) {
      console.error(
        `Publish refused: ${manifest.name} would ship ${dep}@${pinned}, ` +
          `but the workspace version is ${expected}. bun.lock still records ` +
          `the old workspace versions (a plain — or even --force — install ` +
          `does not refresh them): run \`rm bun.lock && bun install\` after ` +
          `versioning, then release again.`
      );
      process.exit(1);
    }
  }
}

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
