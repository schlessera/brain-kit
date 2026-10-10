import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

const CORE_HOOKS = ["pre-commit", "post-commit", "post-checkout", "post-merge"];

function requireFile(path: string, packageName: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(
      `${packageName} publish refused: required build artifact is missing: ${path}`
    );
  }
}

/**
 * The built file behind every export a consumer without the `bun` condition
 * resolves: each subpath's `default` target, or a bare string target, under
 * dist/. Read from the manifest, so a package without a root entry (brain-common
 * exports only `./internal/*`) is checked by what it actually exports.
 */
export function exportedDistFiles(packageDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    exports?: Record<string, string | Record<string, string>>;
  };
  return Object.values(manifest.exports ?? {})
    .map((target) => (typeof target === "string" ? target : target.default))
    .filter((target): target is string => typeof target === "string" && /^\.\/dist\/.+\.js$/.test(target))
    .map((target) => join(packageDir, target));
}

export function assertPublishArtifacts(packageDir: string, packageName: string): void {
  const exported = exportedDistFiles(packageDir);
  if (exported.length === 0) {
    throw new Error(`${packageName} publish refused: its manifest exports no built dist/ entry`);
  }
  for (const file of exported) requireFile(file, packageName);

  if (packageName === "@schlessera/brain-ui-sdk") {
    for (const entry of [
      "protocol.js",
      "schemas.js",
      "server/index.js",
      // React-free tool contracts, imported by server bundles and browsers alike.
      "tool-contracts/index.js",
      "testing/index.js",
      "client/index.js",
      // Its own export subpath: a service worker must import it without
      // dragging in the renderer/ASR registries that client/index.js holds.
      "client/share-target.js",
      // A service worker imports this subpath directly too, so it must build to a real file.
      "client/push-handlers.js",
      // Workbox-free route policy imported directly by a service worker.
      "client/sw-policy.js",
    ]) {
      requireFile(join(packageDir, "dist", entry), packageName);
    }
  }

  if (
    packageName === "@schlessera/brain-ui-react" ||
    packageName === "@schlessera/brain-ui-kit"
  ) {
    requireFile(join(packageDir, "dist", "styles.css"), packageName);
    requireFile(join(packageDir, "dist", "theme.css"), packageName);
  }
  if (packageName === "@schlessera/brain-ui-kit") {
    requireFile(join(packageDir, "dist", "tokens.css"), packageName);
  }

  if (packageName === "@schlessera/brain-ui-server") {
    requireFile(join(packageDir, "dist", "bin", "brain-ui-cron.js"), packageName);
    requireFile(join(packageDir, "dist", "bin", "brain-ui-inbox.js"), packageName);
  }

  if (packageName !== "@schlessera/brain") return;

  requireFile(join(packageDir, "dist", "cli", "brain.js"), packageName);
  // The seam contract suites third-party providers run (#342).
  requireFile(join(packageDir, "dist", "testing", "index.js"), packageName);
  const hooksDir = join(packageDir, "dist", "hooks");
  if (!existsSync(hooksDir) || !statSync(hooksDir).isDirectory()) {
    throw new Error(
      `${packageName} publish refused: required hooks directory is missing: ${hooksDir}`
    );
  }
  if (readdirSync(hooksDir).length === 0) {
    throw new Error(`${packageName} publish refused: hooks directory is empty: ${hooksDir}`);
  }
  for (const hook of CORE_HOOKS) {
    requireFile(join(hooksDir, hook), packageName);
  }
}

if (import.meta.main) {
  const packageDir = resolve(process.cwd());
  const manifest = await Bun.file(join(packageDir, "package.json")).json() as {
    name?: string;
  };
  const packageName = manifest.name ?? packageDir;
  assertPublishArtifacts(packageDir, packageName);
  console.log(`${packageName}: publish artifacts present`);
}
