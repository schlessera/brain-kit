import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

const CORE_HOOKS = ["pre-commit", "post-commit", "post-checkout", "post-merge"];

function requireFile(path: string, packageName: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(
      `${packageName} publish refused: required build artifact is missing: ${path}`
    );
  }
}

export function assertPublishArtifacts(packageDir: string, packageName: string): void {
  requireFile(join(packageDir, "dist", "index.js"), packageName);

  if (packageName === "@endoxa/ui-sdk") {
    for (const entry of ["protocol.js", "schemas.js", "server/index.js", "client/index.js"]) {
      requireFile(join(packageDir, "dist", entry), packageName);
    }
  }

  if (packageName !== "@endoxa/core") return;

  requireFile(join(packageDir, "dist", "cli", "brain.js"), packageName);
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
