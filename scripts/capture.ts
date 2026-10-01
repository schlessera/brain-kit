import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { readCatalogue, type Viewport } from "./captures/catalogue.ts";
import { prepareFontCache, readFontLock, verifyFontCache } from "./captures/fonts.ts";
import { hashTree, outputDirectory, resolveBrowserPin, sha256, sourceProvenance } from "./captures/provenance.ts";
import type { CaptureJob } from "./captures/inside.ts";

const root = resolve(import.meta.dir, "..");

function argumentsFor(argv: string[]): {
  ids: string[]; all: boolean; list: boolean; fonts: boolean; out: string; cache?: string;
  theme?: "dark" | "light"; viewport?: Viewport;
} {
  const result: ReturnType<typeof argumentsFor> = { ids: [], all: false, list: false, fonts: false, out: "tmp/feature-captures" };
  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at];
    if (["--all", "--list", "--prepare-fonts"].includes(argument)) {
      if (argument === "--all") result.all = true;
      else if (argument === "--list") result.list = true;
      else result.fonts = true;
      continue;
    }
    const [name, inline] = argument.split("=", 2);
    if (!["--id", "--out", "--font-cache", "--theme", "--viewport"].includes(name)) throw new Error(`Unknown capture argument: ${argument}`);
    const value = inline ?? argv[++at];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    if (name === "--id") result.ids.push(...value.split(",").filter(Boolean));
    if (name === "--out") result.out = value;
    if (name === "--font-cache") result.cache = resolve(root, value);
    if (name === "--theme") {
      if (value !== "dark" && value !== "light") throw new Error("Capture theme must be dark or light");
      result.theme = value;
    }
    if (name === "--viewport") {
      const match = /^(\d+)x(\d+)$/.exec(value);
      if (!match || Number(match[1]) < 200 || Number(match[2]) < 200) throw new Error("Capture viewport must be WIDTHxHEIGHT, at least 200x200");
      result.viewport = { width: Number(match[1]), height: Number(match[2]) };
    }
  }
  if (result.all && result.ids.length) throw new Error("Choose --all or selected --id values");
  if (result.list && result.fonts) throw new Error("Choose --list or --prepare-fonts");
  return result;
}

async function command(argv: string[]): Promise<void> {
  const process = Bun.spawn(argv, { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  if (await process.exited !== 0) throw new Error(`Capture command failed: ${argv.slice(0, 3).join(" ")}`);
}

async function run(): Promise<void> {
  const options = argumentsFor(process.argv.slice(2));
  const catalogue = await readCatalogue(root);
  const { hash: fontLockHash, lock } = await readFontLock(root);
  const cache = options.cache ?? resolve(tmpdir(), "brain-kit-feature-capture-fonts", fontLockHash);
  if (options.list) {
    for (const entry of catalogue.recipes) console.log(`${entry.id}\tstill\t${entry.theme}\t${entry.output}`);
    for (const entry of catalogue.demo_sequences) console.log(`${entry.id}\tdemo\t${entry.theme}\t${entry.output}`);
    for (const entry of catalogue.harness_requirements) console.log(`${entry.id}\truntime\t${entry.theme}\t${entry.outputs.join(",")}`);
    return;
  }
  if (options.fonts) { await prepareFontCache(root, cache); console.log(`Pinned font inputs and original notices verified (${fontLockHash})`); return; }
  const ids = options.ids.length ? [...new Set(options.ids)] : [...catalogue.recipes, ...catalogue.demo_sequences, ...catalogue.harness_requirements].map((entry) => entry.id);
  const known = new Set([...catalogue.recipes, ...catalogue.demo_sequences, ...catalogue.harness_requirements].map((entry) => entry.id));
  for (const id of ids) if (!known.has(id)) throw new Error(`${id}: unknown approved capture ID; use --list`);
  try { await verifyFontCache(root, cache); }
  catch (error) { throw new Error(`${ids.join(", ")}: ${(error as Error).message}`); }
  const pin = await resolveBrowserPin(root);
  const output = await outputDirectory(root, options.out);
  await mkdir(resolve(root, "tmp"), { recursive: true });
  const lockDirectory = resolve(root,"tmp/.feature-capture-lock");
  try { await mkdir(lockDirectory); }
  catch { throw new Error("Another capture owns this checkout’s build; finish it before capturing again. If it was interrupted, remove tmp/.feature-capture-lock after verifying no capture is running."); }
  let staging: string | undefined, runnerDirectory: string | undefined;
  try {
    await writeFile(resolve(lockDirectory,"owner.json"),JSON.stringify({pid:process.pid})+"\n");
    staging = await mkdtemp(resolve(output, ".capture-"));
    runnerDirectory = await mkdtemp(resolve(root, "tmp/.capture-runner-"));
    let image: Array<{ Id: string; RepoDigests?: string[] }>;
    try { image = JSON.parse(execFileSync("docker", ["image", "inspect", pin.image], { encoding: "utf8" })); }
    catch { await command(["docker", "pull", pin.image]); image = JSON.parse(execFileSync("docker", ["image", "inspect", pin.image], { encoding: "utf8" })); }
    const bun = await realpath(process.execPath);
    // Build and render with the same image's Node. The actual Bun binary is a
    // separately recorded input, needed by the existing build and runtime harnesses.
    const buildInImage = ["docker", "run", "--rm", "--network=none", "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "-v", `${root}:/repo`, "-v", `${bun}:/usr/local/bin/bun:ro`, "-v", `${bun}:/usr/local/bin/bunx:ro`, "-w", "/repo", pin.image];
    const beforeBuild = await sourceProvenance(root);
    await command([...buildInImage, "bun", "run", "build"]);
    await command([...buildInImage, "bun", "run", "--cwd", "packages/ui-kit", "build-storybook"]);
    const source = await sourceProvenance(root);
    if (source.inputs_sha256 !== beforeBuild.inputs_sha256) throw new Error("Capture source changed while building; rerun from settled source");
    const buildHash = await hashTree(root, "packages/ui-kit/storybook-static");
    const bundled = await Bun.build({ entrypoints: [resolve(root, "scripts/captures/inside.ts")], target: "node", external: ["playwright"], outdir: runnerDirectory, naming: "inside.mjs" });
    if (!bundled.success) throw new Error(`Capture runner build failed: ${bundled.logs.join("; ")}`);
    const job: CaptureJob = {
      ids, ...(options.theme ? { theme: options.theme } : {}), ...(options.viewport ? { viewport: options.viewport } : {}),
      provenance: { source, catalogue_sha256: sha256(await readFile(resolve(root, "docs/process/feature-captures.md"))),
        lockfile_sha256: sha256(await readFile(resolve(root, "bun.lock"))), storybook_build_sha256: buildHash,
        runner_bundle_sha256: sha256(await readFile(resolve(runnerDirectory, "inside.mjs"))),
        browser_image: { reference: pin.image, image_id: image[0].Id, repo_digests: image[0].RepoDigests ?? [] },
        playwright_version: pin.playwright, bun: { version: Bun.version, binary_sha256: sha256(await readFile(bun)) },
        fonts: { lock_sha256: fontLockHash, stylesheet_sha256: lock.stylesheet.sha256, assets: lock.assets, notices: lock.licenses },
        locale: catalogue.environment.locale, timezone: catalogue.environment.timezone, device_scale_factor: catalogue.environment.device_scale_factor,
        reduced_motion: catalogue.environment.reduced_motion },
    };
    await writeFile(resolve(staging, "capture-job.json"), JSON.stringify(job) + "\n");
    await command(["docker", "run", "--rm", "--network=none", "--read-only", "--ipc=host", "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "--tmpfs", "/tmp:rw,exec,nosuid,mode=1777", "-v", `${root}:/repo:ro`, "-v", `${cache}:/fonts:ro`,
      "-v", `${staging}:/captures`, "-v", `${bun}:/capture-bun:ro`, "-v", `${bun}:/usr/local/bin/bun:ro`, "-v", `${bun}:/usr/local/bin/bunx:ro`, "-w", "/repo", pin.image, "node", `/repo/${relative(root, runnerDirectory)}/inside.mjs`]);
    if ((await sourceProvenance(root)).inputs_sha256 !== source.inputs_sha256) throw new Error("Capture source changed while rendering; outputs were not accepted");
    const result = JSON.parse(await readFile(resolve(staging, "capture-result.json"), "utf8")) as { artifacts: Array<{ id: string; file: string; files: Array<{file:string}>; theme: string; viewport: Viewport }> };
    if (result.artifacts.length !== ids.length || new Set(result.artifacts.map((entry)=>entry.id)).size!==ids.length || result.artifacts.some((entry) => !ids.includes(entry.id) || !entry.files.length)) throw new Error("Capture runner did not return every selected recipe");
    let previous: { purpose: string; artifacts: unknown[] } = { purpose: "brain-kit editorial captures", artifacts: [] };
    try { previous = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous.purpose !== "brain-kit editorial captures" || !Array.isArray(previous.artifacts)) throw new Error("Unrecognized editorial capture manifest");
    const replaced = new Set(result.artifacts.map((entry) => entry.file));
    const retained = previous.artifacts.filter((entry) => typeof entry === "object" && entry !== null && !replaced.has((entry as { file: string }).file));
    const manifest = { purpose: previous.purpose, selected_ids: ids, artifacts: [...retained, ...result.artifacts] };
    await writeFile(resolve(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const entry of result.artifacts) for (const file of entry.files) await rename(resolve(staging, file.file), resolve(output, file.file));
    await rename(resolve(staging, "manifest.json"), resolve(output, "manifest.json"));
    console.log(`Captured ${ids.length} selected recipes; each artifact records its own source/environment provenance.`);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (runnerDirectory) await rm(runnerDirectory, { recursive: true, force: true });
    await rm(lockDirectory, {recursive:true,force:true});
  }
}

run().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
