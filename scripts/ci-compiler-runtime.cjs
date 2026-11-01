// Executed by actual Node via the same Bun-run PATH/env as the strict compiler.
const { basename } = require("node:path");
const { totalmem, freemem } = require("node:os");
const { getHeapStatistics } = require("node:v8");
if (process.versions.bun || process.release.name !== "node") process.exit(1);
const typescript = require(require.resolve("typescript/package.json", { paths: [process.cwd()] })).version;
console.log(`BRAIN_COMPILER_RUNTIME ${JSON.stringify({
  scope: "Node probe under compiler PATH/env; not compiler RSS",
  executable: basename(process.execPath), runtime: process.release.name, version: process.version, typescript,
  heapLimitBytes: getHeapStatistics().heap_size_limit,
  capacity: { scope: "OS-visible memory; cgroup limit may be lower", totalBytes: totalmem(), freeBytes: freemem() },
})}`);
