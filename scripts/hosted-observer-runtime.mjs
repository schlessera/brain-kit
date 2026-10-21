/** Diagnostic prerequisite only: never install or change the runner runtime. */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function runtimeIdentity() {
  const file = statSync(process.execPath);
  return { node: process.version, versions: process.versions, platform: process.platform,
    architecture: process.arch, execPath: process.execPath,
    executable: { size: file.size, dev: file.dev, ino: file.ino, mtimeMs: file.mtimeMs },
    supported: process.platform === "linux" && process.versions.node.startsWith("24.") };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const identity = runtimeIdentity();
  console.log(JSON.stringify({ kind: "hosted-observer-runtime", ...identity }));
  if (process.argv[2]) {
    mkdirSync(dirname(resolve(process.argv[2])), { recursive: true });
    writeFileSync(resolve(process.argv[2]), JSON.stringify(identity, null, 2));
  }
  if (!identity.supported) { console.error("HOSTED_OBSERVER_INCOMPLETE requires Linux Node 24 before workload"); process.exitCode = 1; }
}
