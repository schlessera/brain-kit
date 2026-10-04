// #544: the actual scanner -> clicked FileLink -> store -> served app ->
// PDF/image viewer chain. Regex/classifier controls alone missed this failure.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";
import { runCli } from "../../core/tests/cli-harness.ts";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.ts";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Scratch link runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING scratch link runtime proof: no Chrome; preview/download chain is unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
let fixture: string | undefined;
let brain = "", origin = "";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
const files: Record<string, string> = {};
const bytes: Record<string, Buffer> = {};

async function child(args: string[], cwd = repo): Promise<void> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`Scratch fixture preparation failed (${code}): ${out}\n${err}`);
}

beforeAll(async () => {
  if (!executablePath) return;
  // The client bundle uses fresh source plus ordinary package resolution.
  // Rebuild dependencies so a runtime mutation cannot hide behind stale dist.
  await child([process.execPath, "scripts/build.ts"]);
  fixture = await mkdtemp(resolve(tmpdir(), "odysseus-scratch-links-"));
  brain = resolve(fixture, "brain");
  await createFixtureBrain(repo, brain);
  // Chrome's Linux launcher uses these utilities. Keep PATH test-owned and
  // restricted rather than exposing ambient agent/provider executables.
  const renderBin = resolve(fixture, "render-bin");
  await mkdir(renderBin);
  await symlink(process.execPath, resolve(renderBin, "bun"));
  for (const name of ["git", "touch", "readlink", "dirname", "cat"]) {
    const executable = Bun.which(name);
    if (executable) await symlink(executable, resolve(renderBin, name));
  }
  await writeFile(resolve(brain, ".gitignore"), ".brain/scratch/\n");
  for (const format of ["pdf", "png"]) {
    const result = await runCli(brain, ["render", "notes/raft-reference.md", "--format", format, "--scratch", "--json"], {
      PATH: renderBin,
      PUPPETEER_EXECUTABLE_PATH: executablePath,
      BRAIN_UI_CHROME_PATH: executablePath,
      BRAIN_UI_CHROME_NO_SANDBOX: "1",
    });
    if (result.code !== 0) throw new Error(`Real scratch render failed: ${result.stderr}`);
    const rendered = JSON.parse(result.stdout) as { output: string; bytes: number; warnings: unknown[] };
    expect(rendered.output).toStartWith(".brain/scratch/");
    expect(rendered.bytes).toBeGreaterThan(1000);
    expect(rendered.warnings).toEqual([]);
    files[format] = rendered.output;
    bytes[format] = await readFile(resolve(brain, rendered.output));
  }
  const assets = resolve(fixture, "assets");
  await mkdir(assets);
  await child([process.execPath, "-e", 'const r=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!r.success){console.error(r.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/scratch-links-client.tsx"), assets]);
  await writeFile(resolve(assets, "scratch-fixture.json"), JSON.stringify(files));
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Odysseus scratch preview</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:var(--bk-color-canvas);color:var(--bk-color-ink)}main{max-width:900px;margin:auto}section[aria-label="Chat answer"]{padding:16px}section[aria-label="File viewer"]{height:700px;min-width:0}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  const backend = makeFakeBackend({ id: "scratch-fixture" });
  app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(fixture, "ui.db"),
    AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([backend], backend.id), staticRoot: assets, observability: createRecordingObservability() });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  await app?.close();
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

async function open(format: string, mode: string, theme: string, width: number) {
  const context = await browser!.newContext({ viewport: { width, height: 900 } });
  const outside: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    outside.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  const contentResponses: Array<{ path: string | null; status: number }> = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/files/content") contentResponses.push({ path: url.searchParams.get("path"), status: response.status() });
  });
  await page.goto(`${origin}/?${new URLSearchParams({ format, mode, theme })}`);
  await page.waitForFunction("window.__scratchFixture !== undefined");
  return { page, context, outside, contentResponses };
}

async function activate(page: Page, keyboard = false) {
  const link = page.locator('section[aria-label="Chat answer"] a.brain-file-link');
  expect(await link.count()).toBe(1);
  if (keyboard) { await link.focus(); await page.keyboard.press("Enter"); }
  else await link.click();
  await page.waitForFunction("window.__scratchFixture.state().path !== null && !window.__scratchFixture.state().loading");
  return page.evaluate("window.__scratchFixture.state()") as Promise<{ path: string; error: string | null; kind?: string; mime?: string }>;
}

describe.skipIf(!executablePath)("real scratch output through a chat link and viewer", () => {
  for (const format of ["pdf", "png"]) for (const mode of ["prose", "code", "markdown"])
    for (const [theme, width] of [["dark", 320], ["light", 1280]] as const) {
      test(`${format} ${mode} opens without File not found (${theme}, ${width}px)`, async () => {
        const { page, context, outside, contentResponses } = await open(format, mode, theme, width);
        try {
          const state = await activate(page);
          // First behavioral assertion: the original scanner reaches the real
          // route with the wrong path and fails here with "File not found."
          expect(state.error).toBeNull();
          expect(state).toMatchObject({ path: files[format], kind: "binary", mime: format === "pdf" ? "application/pdf" : "image/png" });
          if (format === "pdf") {
            await page.waitForFunction(() => {
              const canvas = document.querySelector<HTMLCanvasElement>('section[aria-label="File viewer"] canvas');
              if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
              const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
              let painted = 0;
              for (let i = 0; i < data.length; i += 4) if (data[i]! < 240 && data[i + 1]! < 240 && data[i + 2]! < 240 && data[i + 3]! > 0) painted++;
              return painted > 500;
            });
          } else {
            await page.waitForFunction(() => {
              const image = document.querySelector<HTMLImageElement>('section[aria-label="File viewer"] img');
              return image && image.complete && image.naturalWidth > 100 && image.naturalHeight > 100;
            });
          }
          expect(await page.getByText("File not found.", { exact: true }).count()).toBe(0);
          const download = page.getByRole("link", { name: "Download", exact: true });
          const href = await download.getAttribute("href");
          expect(href).toBe(`/api/files/content?path=${encodeURIComponent(files[format]!)}&raw=1`);
          const raw = await fetch(new URL(href!, origin));
          expect(raw.status).toBe(200);
          expect(raw.headers.get("content-type")).toBe(format === "pdf" ? "application/pdf" : "image/png");
          expect(Buffer.from(await raw.arrayBuffer()).equals(bytes[format]!)).toBe(true);
          expect(contentResponses.some((response) => response.path === files[format] && response.status === 200)).toBe(true);
          expect(outside).toEqual([]);
        } finally { await context.close(); }
      }, 60_000);
    }

  test("scratch stays hidden while a nonempty normal tree remains browsable", async () => {
    const response = await fetch(`${origin}/api/files/tree?path=`);
    expect(response.status).toBe(200);
    const tree = await response.json() as { entries: Array<{ name: string }> };
    expect(tree.entries.some((entry) => entry.name === "notes")).toBe(true);
    expect(tree.entries.some((entry) => entry.name === ".brain")).toBe(false);
  });

  test("the existing server path guard refuses traversal on preview and raw routes", async () => {
    for (const raw of ["0", "1"]) {
      const response = await fetch(`${origin}/api/files/content?${new URLSearchParams({ path: "../notes/raft-reference.md", raw })}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_path" });
    }
  });

  test("keyboard activation opens the same generated PDF", async () => {
    const { page, context } = await open("pdf", "code", "dark", 1280);
    try { expect(await activate(page, true)).toMatchObject({ path: files.pdf, error: null, kind: "binary" }); }
    finally { await context.close(); }
  }, 60_000);

  test("deleting the generated file really reaches the missing-file state", async () => {
    const file = resolve(brain, files.pdf!);
    await rename(file, file + ".held");
    try {
      const { page, context } = await open("pdf", "markdown", "dark", 1280);
      try {
        expect((await activate(page)).error).toBe("File not found.");
        expect(await page.getByText("File not found.", { exact: true }).count()).toBe(1);
        expect((await fetch(`${origin}/api/files/content?${new URLSearchParams({ path: files.pdf!, raw: "1" })}`)).status).toBe(404);
      } finally { await context.close(); }
    } finally { await rename(file + ".held", file); }
  }, 60_000);
});
