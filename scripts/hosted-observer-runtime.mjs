/** Diagnostic prerequisite only: never install or change the runner runtime. */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const runtimeRequirement = "Linux Node 22.23.3 or 24 with native TypeScript stripping";

export function runtimeIdentity() {
  const file = statSync(process.execPath);
  return { node: process.version, versions: process.versions, platform: process.platform,
    architecture: process.arch, execPath: process.execPath, typescript: process.features.typescript ?? false,
    executable: { size: file.size, dev: file.dev, ino: file.ino, mtimeMs: file.mtimeMs },
    // Node 22.23.3 is the observed hosted runtime; keep the existing Node 24 path.
    // Refuse disabled stripping before the workload, without adding loader flags.
    supported: process.platform === "linux" && process.features.typescript === "strip" &&
      (process.versions.node === "22.23.3" || process.versions.node.startsWith("24.")) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const identity = runtimeIdentity();
  console.log(JSON.stringify({ kind: "hosted-observer-runtime", ...identity }));
  if (process.argv[2]) {
    mkdirSync(dirname(resolve(process.argv[2])), { recursive: true });
    writeFileSync(resolve(process.argv[2]), JSON.stringify(identity, null, 2));
  }
  if (!identity.supported) { console.error(`HOSTED_OBSERVER_INCOMPLETE requires ${runtimeRequirement} before workload`); process.exitCode = 1; }
}
