/** Source and ordinary default-export runtime proof in an installed consumer. */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
const flag = process.argv.indexOf("--root");
if (flag === -1 || !process.argv[flag + 1])
  throw new Error("check-query-package requires --root <consumer install>");
const consumer = resolve(process.argv[flag + 1]);
const probeDir = mkdtempSync(join(consumer, ".query-package-probe-"));
const missingRoot = mkdtempSync(join(tmpdir(), "brain-query-package-"));
const probe = join(probeDir, "probe.ts");
try {
  await Bun.write(probe, `
import * as queries from "@schlessera/brain/queries";
const brainPath = ${JSON.stringify(missingRoot)};
const calls = [
  () => queries.readGraphMeta({ brainPath }),
  () => queries.readGraphClusters({ brainPath }),
  () => queries.readGraphNeighborhood({ brainPath, center: "notes/ithaca.md" }),
  () => queries.readGraphDiscovery({ brainPath }),
  () => queries.readGraphMaintenance({ brainPath }),
  () => queries.readLinkWalk({ brainPath, path: "notes/ithaca.md" }),
  () => queries.readVoiceVocabulary({ brainPath, limit: 20 }),
  () => queries.listIndexDocuments({ brainPath }),
  () => queries.findIndexDocuments({ brainPath }),
];
for (const call of calls) {
  const result = call();
  if (result.ok || result.error.code !== "missing_index" || result.error.retryable) {
  throw new Error("Packed query API did not return the safe missing-index result");
  }
}
console.log("nine packed query operations: safe runtime results");
`);
  const source = Bun.spawn([process.execPath, probe], { cwd: consumer, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  if (await source.exited !== 0)
    throw new Error("Query package source imports failed");
  // Node is an ordinary bundler target: it selects default JS, without a
  // custom/forced condition. Bun executes the bundle's native bun:sqlite import.
  const built = await Bun.build({ entrypoints: [probe], target: "node", format: "esm", outdir: join(probeDir, "built"), external: ["bun:sqlite"], metafile: true });
  if (!built.success)
    throw new Error(`Query consumer build failed: ${built.logs.join("\n")}`);
  const inputs = Object.keys(built.metafile?.inputs ?? {});
  if (!inputs.some(path => path.endsWith("/dist/queries/index.js")) || inputs.some(path => path.includes("/brain/src/"))) {
    throw new Error("Ordinary default consumer did not select compiled query JavaScript");
  }
  const runtime = Bun.spawn([process.execPath, built.outputs[0].path], { cwd: consumer, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  if (await runtime.exited !== 0)
    throw new Error("Query package compiled imports failed");
  console.log("query package: source and default JavaScript consumer checks pass");
}
finally {
  rmSync(probeDir, { recursive: true, force: true });
  rmSync(missingRoot, { recursive: true, force: true });
}
