import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.ts";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find(path => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath) throw new Error("Artifact recovery proof requires real Chrome");
const repo = resolve(import.meta.dir, "../../..");
const target = ".brain/scratch/raft/overview.pdf";
const password = "the bow only Odysseus can string";
let fixture = "", brain = "", origin = "";
let app: Awaited<ReturnType<typeof createApp>>;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let activeApp: typeof app;
let passwordHash = "";

/** Valid one-page PDF, so native parsing/painting also runs without a provider. */
function pdf(): Uint8Array {
  const stream = "BT /F1 24 Tf 72 720 Td (Odysseus reviews the raft) Tj ET";
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  return new TextEncoder().encode(out + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function child(args: string[]) {
  const process = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`Artifact fixture build failed (${code})\n${out}${err}`);
}

beforeAll(async () => {
  // A focused source mutation still bundles the client below from its fresh
  // source; only already-built, unchanged workspace dependencies may be reused.
  if (process.env.BRAIN_ARTIFACT_DEPENDENCIES_BUILT !== "1") await child([process.execPath, "scripts/build.ts"]);
  fixture = await mkdtemp(resolve(tmpdir(), "odysseus-artifact-recovery-"));
  brain = resolve(fixture, "brain");
  await createFixtureBrain(repo, brain);
  await mkdir(resolve(brain, ".brain/scratch/raft"), { recursive: true });
  await writeFile(resolve(brain, ".gitignore"), ".brain/scratch/\n");
  await writeFile(resolve(brain, target), pdf());
  await writeFile(resolve(brain, ".brain/scratch/raft/other.pdf"), pdf());
  await writeFile(resolve(brain, ".brain/scratch/raft/overview.html"), "<!doctype html><h1>The raft of Odysseus</h1>");
  await writeFile(resolve(brain, ".brain/scratch/raft/hull.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=", "base64"));
  const assets = resolve(fixture, "assets");
  await mkdir(assets);
  await child([process.execPath, "-e", 'const r=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!r.success){console.error(r.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/artifact-recovery-client.tsx"), assets]);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odysseus artifact recovery</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;background:var(--bk-color-canvas);color:var(--bk-color-ink)}main{padding:16px}article{margin:24px 0}textarea{display:block;max-width:100%}[data-bk-nav]{height:44px}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  const backend = makeFakeBackend({ id: "artifact-fixture" });
  passwordHash = await Bun.password.hash(password);
  app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(fixture, "ui.db"), AUTH_MODE: "password", HOST: "127.0.0.1", NODE_ENV: "test",
    BRAIN_UI_PASSWORD_HASH: passwordHash, COOKIE_SECRET: "odysseus-artifact-cookie-secret-0123456789", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([backend], backend.id), staticRoot: assets, observability: createRecordingObservability() });
  activeApp = app;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => activeApp.fetch(request), websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 180_000);

afterAll(async () => { await browser?.close(); server?.stop(true); await app?.close(); if (fixture) await rm(fixture, { recursive: true, force: true }); });

async function scene(width = 1280, theme = "dark", path = target, replay = false) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
  const outside: string[] = [];
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (outside.push(route.request().url()), route.abort()));
  const login = await context.request.post(`${origin}/api/auth/login`, { data: { password } });
  expect(login.status()).toBe(200);
  const page = await context.newPage();
  await page.goto(`${origin}/?${new URLSearchParams({ theme, path, ...(replay ? { replay: "1" } : {}) })}`);
  await page.getByRole("link", { name: "the raft overview", exact: true }).waitFor();
  await page.waitForFunction(() => (window as any).__artifactFixture.state().auth === "active");
  if (path.startsWith(".brain/scratch/")) await page.waitForFunction(() => (window as any).__artifactFixture.state().reference === "present");
  return { page, context, outside };
}

async function activate(page: Page, keyboard = false) {
  const link = page.getByRole("link", { name: "the raft overview", exact: true });
  if (keyboard) { await link.focus(); await page.keyboard.press("Enter"); } else await link.click();
  await page.locator("[data-file-title]").waitFor();
  await page.waitForFunction(() => (window as any).__artifactFixture.state().path !== null && !(window as any).__artifactFixture.state().loading);
}

async function metadataStatus(page: Page, status: number, size?: number) {
  await page.route("**/api/files/content?*", route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && !url.searchParams.has("raw")) return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "private backend detail", ...(size === undefined ? {} : { size }) }) });
    return route.fallback();
  });
}

for (const [status, copy] of [[403, "This file isn't available with your current access."], [500, "Couldn't open this file."], [413, "Too large to preview here."]] as const) {
  test(`artifact status ${status} is truthful, neutral and has only supported actions`, async () => {
    const { page, context, outside } = await scene();
    try {
      await metadataStatus(page, status);
      await activate(page);
      expect(await page.getByRole("heading", { name: copy, exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(status === 500 ? 1 : 0);
      expect(await page.locator('a[download]').count()).toBe(0);
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(await page.getByText("private backend detail", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("link", { name: "the raft overview", exact: true }).getAttribute("aria-disabled")).toBeNull();
      expect(outside).toEqual([]);
    } finally { await context.close(); }
  });
}

test("artifact offline remains unknown; manual retry is one flight and online does not retry", async () => {
  const { page, context, outside } = await scene();
  try {
    let requests = 0, hold: (() => Promise<void>) | undefined;
    let observed: () => void = () => {};
    const retried = new Promise<void>(resolve => { observed = resolve; });
    await page.route("**/api/files/content?*", route => {
      if (route.request().method() !== "GET" || new URL(route.request().url()).searchParams.has("raw")) return route.fallback();
      requests++;
      if (requests === 1) return route.abort("internetdisconnected");
      return new Promise<void>(resolve => { hold = async () => { await route.continue(); resolve(); }; observed(); });
    });
    await activate(page, true);
    expect(await page.getByRole("heading", { name: "Can't reach your brain right now.", exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("The file may still be there.", { exact: true }).isVisible()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect(requests).toBe(1);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await retried;
    await page.waitForFunction(() => (window as any).__artifactFixture.state().loading);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-file-title"))).toBe(true);
    expect(requests).toBe(2);
    expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(0);
    await hold!();
    await page.waitForFunction(() => !(window as any).__artifactFixture.state().loading);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-file-title"))).toBe(true);
    expect(outside).toEqual([]);
  } finally { await context.close(); }
});

test("artifact delayed load closes immediately and late completion never reopens it", async () => {
  const { page, context } = await scene();
  try {
    let hold: (() => Promise<void>) | undefined;
    await page.route("**/api/files/content?*", route => {
      if (route.request().method() !== "GET" || new URL(route.request().url()).searchParams.has("raw")) return route.fallback();
      return new Promise<void>(resolve => { hold = async () => { await route.fulfill({ status: 500, body: JSON.stringify({ error: "old failure" }) }); resolve(); }; });
    });
    await page.getByRole("link", { name: "the raft overview", exact: true }).click();
    await page.getByRole("status").waitFor();
    expect(await page.getByRole("status").textContent()).toContain("Loading file");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().path)).toBeNull();
    await hold!();
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().open)).toBe(false);
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().path)).toBeNull();
  } finally { await context.close(); }
});

test("artifact scratch404 makes opener inert and Close returns focus to its paragraph", async () => {
  const { page, context } = await scene(320);
  try {
    await metadataStatus(page, 404);
    await activate(page, true);
    expect(await page.getByRole("heading", { name: "This file has expired", exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Close Files", exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => document.activeElement?.tagName), "EXPIRED_OPENER_FOCUS_RETURN").toBe("P");
    expect(await page.getByRole("link", { name: "the raft overview expired", exact: true }).getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByRole("link", { name: "the raft overview expired", exact: true }).getAttribute("tabindex")).toBeNull();
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().entry)).toBe(false);
  } finally { await context.close(); }
});

test("artifact ordinary404 stays not-found without expired reference decoration", async () => {
  const { page, context } = await scene(1280, "dark", "notes/raft-reference.md");
  try { await metadataStatus(page, 404); await activate(page); expect(await page.getByRole("heading", { name: "File not found", exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("link", { name: "the raft overview", exact: true }).getAttribute("aria-disabled")).toBeNull(); }
  finally { await context.close(); }
});

for (const replay of [false, true]) {
  test(`artifact ${replay ? "replayed" : "live"} present reference paints a real PDF without age-based expiry`, async () => {
    const { page, context, outside } = await scene(1280, "dark", target, replay);
    try {
      await activate(page, true);
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLCanvasElement>("canvas")].some(canvas => canvas.width > 0 && canvas.height > 0));
      expect(await page.getByRole("link", { name: "the raft overview", exact: true }).getAttribute("aria-disabled")).toBeNull();
      expect(await page.getByRole("link", { name: "Download", exact: true }).count()).toBe(1);
      expect(outside).toEqual([]);
    } finally { await context.close(); }
  });
}

test("artifact latest open owns the visible result even when the old request fails later", async () => {
  const { page, context } = await scene();
  try {
    let finish: (() => Promise<void>) | undefined, observed: () => void = () => {};
    const pending = new Promise<void>(resolve => { observed = resolve; });
    await page.route("**/api/files/content?*", route => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && !url.searchParams.has("raw") && url.searchParams.get("path") === target) {
        return new Promise<void>(resolve => { finish = async () => { await route.fulfill({ status: 404, body: JSON.stringify({ error: "old missing" }) }); resolve(); }; observed(); });
      }
      return route.fallback();
    });
    await page.getByRole("link", { name: "the raft overview", exact: true }).click();
    await pending;
    await page.evaluate(() => { void (window as any).__artifactFixture.open("notes/raft-reference.md"); });
    await page.waitForFunction(() => (window as any).__artifactFixture.state().kind === "markdown");
    await finish!();
    expect(await page.evaluate(() => (window as any).__artifactFixture.state())).toMatchObject({ path: "notes/raft-reference.md", kind: "markdown", expired: false, failure: undefined });
    expect(await page.locator("[data-file-title]").textContent()).toBe("raft-reference.md");
  } finally { await context.close(); }
});

test("artifact authoritative answer rewrite keeps the current viewer and opens the updated reference normally", async () => {
  const { page, context } = await scene();
  try {
    await activate(page);
    await page.evaluate(() => (window as any).__artifactFixture.rewrite(".brain/scratch/raft/other.pdf"));
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().path)).toBe(target);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("link", { name: "the raft overview", exact: true }).waitFor();
    expect(await page.getByRole("link", { name: "the raft overview", exact: true }).getAttribute("href")).toBe("#/files/.brain/scratch/raft/other.pdf");
    await activate(page);
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().path)).toBe(".brain/scratch/raft/other.pdf");
  } finally { await context.close(); }
});

test("artifact413 displays a supplied finite size and never offers a download bypass", async () => {
  const { page, context } = await scene(320);
  try { await metadataStatus(page, 413, 42 * 1024 * 1024); await activate(page); expect(await page.getByText("42.00 MB", { exact: true }).isVisible()).toBe(true);
    expect(await page.locator("a[download]").count()).toBe(0); }
  finally { await context.close(); }
});

test("artifact real401 invokes existing gate, drops bytes/opener and requires manual reopen", async () => {
  const { page, context } = await scene(1280, "dark", "notes/raft-reference.md");
  try {
    await activate(page, true);
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().kind)).toBe("markdown");
    await context.clearCookies();
    await page.evaluate(path => (window as any).__artifactFixture.open(path), target);
    await page.locator('input[type="password"]').waitFor();
    expect(await page.locator("[data-file-title]").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__artifactFixture.state())).toMatchObject({ path: null, entry: false, open: false, auth: "locked" });
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("link", { name: "the raft overview", exact: true }).waitFor();
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().path)).toBeNull();
    await activate(page);
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().kind)).toBe("markdown");
  } finally { await context.close(); }
});

test("artifact account switch cannot inherit old bytes, path or opener identity", async () => {
  const { page, context } = await scene(1280, "dark", "notes/raft-reference.md");
  let other: typeof app | undefined;
  try {
    await activate(page, true);
    const oldAccount = await page.evaluate(() => (window as any).__artifactFixture.state().account);
    const backend = makeFakeBackend({ id: "artifact-fixture" });
    other = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(fixture, "other-ui.db"), AUTH_MODE: "password", HOST: "127.0.0.1", NODE_ENV: "test",
      BRAIN_UI_PASSWORD_HASH: passwordHash, COOKIE_SECRET: "odysseus-other-cookie-secret-0123456789", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
      registry: createStaticBackendRegistry([backend], backend.id), staticRoot: resolve(fixture, "assets"), observability: createRecordingObservability() });
    activeApp = other;
    await page.evaluate(path => (window as any).__artifactFixture.open(path), target);
    await page.locator('input[type="password"]').waitFor();
    expect(await page.locator("[data-file-title]").count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__artifactFixture.state())).toMatchObject({ path: null, entry: false, open: false, auth: "locked" });
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("link", { name: "the raft overview", exact: true }).waitFor();
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().account)).not.toBe(oldAccount);
    expect(await page.evaluate(() => (window as any).__artifactFixture.state())).toMatchObject({ path: null, kind: undefined, entry: false, open: false });
  } finally { await context.close(); activeApp = app; await other?.close(); }
});

for (const [path, route] of [[target, "**/api/files/content?*"], [".brain/scratch/raft/hull.png", "**/api/files/content?*"], [".brain/scratch/raft/overview.html", "**/api/files/html?*"]] as const) {
  test(`artifact secondary ${path.split(".").at(-1)}404 is confirmed without a false download`, async () => {
    const { page, context } = await scene(1280, "dark", path);
    try {
      await page.route(route, intercepted => {
        const url = new URL(intercepted.request().url());
        if (url.pathname.endsWith("/html") || url.searchParams.get("raw") === "1") return intercepted.fulfill({ status: 404, body: "not found" });
        return intercepted.fallback();
      });
      await activate(page);
      await page.getByRole("heading", { name: "This file has expired", exact: true }).waitFor();
      expect(await page.locator("a[download]").count()).toBe(0);
    } finally { await context.close(); }
  });
}

for (const width of [320, 1280]) for (const theme of ["dark", "light"]) {
  test(`artifact layout ${theme} ${width}: bounded controls, named status and keyboard return`, async () => {
    const { page, context, outside } = await scene(width, theme);
    try {
      await metadataStatus(page, 500);
      await activate(page, true);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-file-title"))).toBe(true);
      expect(await page.getByRole("status").count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const retry = await page.getByRole("button", { name: "Try again", exact: true }).boundingBox();
      expect(retry!.height, "RETRY_44PX_TARGET").toBeGreaterThanOrEqual(44);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).evaluate(element => {
        const r = element.getBoundingClientRect();
        return [[r.left + 1, r.top + r.height / 2], [r.right - 1, r.top + r.height / 2], [r.left + r.width / 2, r.top + 1], [r.left + r.width / 2, r.bottom - 1]]
          .every(([x, y]) => element.contains(document.elementFromPoint(x!, y!)));
      }), "RETRY_EDGE_HIT_TESTS").toBe(true);
      await page.screenshot({ path: resolve(fixture, `artifact-${theme}-${width}.png`) });
      if (process.env.BRAIN_ARTIFACT_SCREENSHOTS) await page.screenshot({ path: resolve(process.env.BRAIN_ARTIFACT_SCREENSHOTS, `artifact-${theme}-${width}.png`) });
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "200PCT_ZOOM_NO_HORIZONTAL_OVERFLOW").toBe(true);
      expect(await page.getByRole("button", { name: "Try again", exact: true }).isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.classList.contains("brain-file-link"));
      expect(await page.evaluate(() => (window as any).__artifactFixture.state().open)).toBe(false);
      expect(outside).toEqual([]);
    } finally { await context.close(); }
  });
}

for (const width of [320, 1280]) {
  test(`artifact navigation ${width} preserves selected destination focus`, async () => {
    const { page, context } = await scene(width);
    try {
      await metadataStatus(page, 500);
      await activate(page, true);
      const chat = page.getByRole("navigation", { name: "Primary" }).locator("visible=true").getByRole("tab", { name: /^Chat/ });
      await chat.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !(window as any).__artifactFixture.state().open);
      expect(await chat.evaluate(el => document.activeElement === el)).toBe(true);
      expect(await page.evaluate(() => (window as any).__artifactFixture.state().entry)).toBe(false);
    } finally { await context.close(); }
  });
}

test("artifact nested More Escape leaves Files open and Close file focuses Files heading", async () => {
  const { page, context } = await scene(320);
  try {
    await metadataStatus(page, 500);
    await activate(page, true);
    await page.getByRole("tab", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "More", exact: true }).waitFor({ state: "hidden" });
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().open)).toBe(true);
    await page.getByRole("button", { name: "Close file", exact: true }).click();
    await page.waitForFunction(() => (window as any).__artifactFixture.state().path === null);
    expect(await page.locator("[data-destination-heading]").evaluate(el => document.activeElement === el)).toBe(true);
  } finally { await context.close(); }
});

test("artifact reopening after desktop-to-phone transition retains the visible destination", async () => {
  const { page, context } = await scene(1280);
  try {
    await metadataStatus(page, 500);
    await activate(page, true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !(window as any).__artifactFixture.state().open);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("tab", { name: "More", exact: true }).waitFor({ state: "visible" });
    await activate(page, true);
    expect(await page.getByRole("heading", { name: "Couldn't open this file.", exact: true }).isVisible()).toBe(true);
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-file-title"), undefined, { timeout: 1000 });
    expect(await page.locator("[data-file-title]").evaluate(el => document.activeElement === el)).toBe(true);
  } finally { await context.close(); }
});

for (const width of [320, 1280]) for (const theme of ["dark", "light"]) {
  test(`artifact full state matrix ${theme} ${width} preserves named static loading and truthful controls`, async () => {
    const { page, context } = await scene(width, theme);
    let status = 0, release: (() => void) | undefined;
    try {
      await page.route("**/api/files/content?*", async route => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET" || url.searchParams.has("raw")) return route.fallback();
        if (status === 0) { await new Promise<void>(resolve => { release = resolve; }); return route.fulfill({ status: 500, body: "{}" }); }
        if (status === -1) return route.abort("internetdisconnected");
        if (status === 200) return route.fallback();
        return route.fulfill({ status, contentType: "application/json", body: "{}" });
      });
      const link = page.getByRole("link", { name: "the raft overview", exact: true });
      await link.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("status").filter({ hasText: "Loading file" }).waitFor();
      expect(await page.locator(".bk-ghost").evaluateAll(nodes => nodes.length > 0 && nodes.every(el => getComputedStyle(el).animationName === "none")), "REDUCED_MOTION_STATIC_LOADING").toBe(true);
      release!();
      await page.getByRole("heading", { name: "Couldn't open this file.", exact: true }).waitFor();
      for (const [next, title, retry] of [[-1, "Can't reach your brain right now.", true], [403, "This file isn't available with your current access.", false], [413, "Too large to preview here.", false], [200, "overview.pdf", false], [404, "This file has expired", false]] as const) {
        status = next;
        await page.evaluate(path => (window as any).__artifactFixture.open(path), target);
        await page.getByRole("heading", { name: title, exact: true }).waitFor();
        expect(await page.getByRole("status").count()).toBe(1);
        expect(await page.getByRole("alert").count()).toBe(0);
        expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(retry ? 1 : 0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (next === 200) await page.locator("canvas").waitFor();
        if (next !== 200) expect(await page.locator("a[download]").count()).toBe(0);
      }
    } finally { release?.(); await context.close(); }
  });
}

test("artifact actual HTML route confirms a successful native preview without replacing it", async () => {
  const path = ".brain/scratch/raft/overview.html";
  const { page, context, outside } = await scene(1280, "dark", path);
  try {
    const confirmation = page.waitForResponse(response => response.request().method() === "HEAD" && new URL(response.url()).pathname === "/api/files/html");
    await activate(page);
    expect((await confirmation).status(), "REAL_HTML_HEAD_AVAILABLE").toBe(200);
    await page.frameLocator('iframe[title="HTML preview"]').getByRole("heading", { name: "The raft of Odysseus", exact: true }).waitFor();
    expect(await page.locator('iframe[title="HTML preview"]').isVisible()).toBe(true);
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().kind)).toBe("html");
    expect(await page.evaluate(() => (window as any).__artifactFixture.state().failure)).toBeUndefined();
    expect(outside).toEqual([]);
  } finally { await context.close(); }
});
