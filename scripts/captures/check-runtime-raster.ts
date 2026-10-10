import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { readFontLock, verifyFontCache } from "./fonts.ts";
import { outputDirectory, resolveBrowserPin, sha256, sourceProvenance } from "./provenance.ts";

const root = resolve(import.meta.dir, "../..");
if (!process.argv[2]) throw new Error("Runtime raster check requires a dedicated output directory");
const output = await outputDirectory(root, process.argv[2]);
const { hash } = await readFontLock(root);
const cache = process.argv[3] ? resolve(process.argv[3]) : resolve(tmpdir(), "brain-kit-feature-capture-fonts", hash);
await verifyFontCache(root, cache);
const pin = await resolveBrowserPin(root), bun = await realpath(process.execPath);
const source = await sourceProvenance(root);
await writeFile(resolve(output, "provenance.json"), JSON.stringify({ source, browser_image: pin.image,
  playwright_version: pin.playwright, font_lock_sha256: hash,
  bun: { version: Bun.version, binary_sha256: sha256(await readFile(bun)) } }, null, 2) + "\n");
const runner = await mkdtemp(resolve(root, "tmp/.raster-check-"));
try {
  const build = await Bun.build({ entrypoints: [resolve(root, "scripts/captures/raster-regression.ts")], target: "node", external: ["playwright"], outdir: runner, naming: "raster.mjs" });
  if (!build.success) throw new Error(`Runtime raster check build failed: ${build.logs.join("; ")}`);
  const child = Bun.spawn(["docker", "run", "--rm", "--network=none", "--read-only", "--ipc=host",
    "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, "--tmpfs", "/tmp:rw,exec,nosuid,mode=1777",
    "-v", `${root}:/repo:ro`, "-v", `${cache}:/fonts:ro`, "-v", `${output}:/captures`, "-v", `${bun}:/capture-bun:ro`,
    "-w", "/repo", pin.image, "node", `/repo/${relative(root, runner)}/raster.mjs`],
  { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  if (await child.exited !== 0) throw new Error("Runtime paint-history regression failed; original observations retained");
  if ((await sourceProvenance(root)).inputs_sha256 !== source.inputs_sha256) throw new Error("Runtime raster source changed during verification");
} finally { await rm(runner, { recursive: true, force: true }); }
