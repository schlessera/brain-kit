import { runtimePackageBuild } from "./fixtures/runtime-package-build";
// #2673: the Files panel's untrusted marks in real Chrome against a real
// password-mode server, as the owner and as an agent reader: the toolbar
// states, cues, list, dialogs, races, focus, live region, disclosure and
// layout at 320px and 1440px, light and dark, and 200% zoom at 320px.
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { chromium, type Browser, type Page } from "playwright";
import { createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import { createPrincipal, type Principal } from "../../ui-server/src/db/principals.js";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.ts";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Untrusted marks runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING untrusted marks runtime proof: no Chrome; the Files marks UI is unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
const SECRET = "untrusted-marks-runtime-secret-0123456789";
const MESSAGE = "inbox/message-from-eurymachus.md";
const LETTER = "inbox/letter-from-antinous.md";
const MOVED = "people/suitors/antinous-letter.md";
const LOOM = "notes/penelope-loom.md";
const HOSTILE = "inbox/[x](evil.invalid) <b>bold <img src=x onerror=alert(1)>.md";
const JULY_12 = Date.UTC(2026, 6, 12, 9), JULY_11 = Date.UTC(2026, 6, 11, 9);
const PROXY = "On turns that run through the egress proxy, web access is limited to the untrusted allow-list and sites this chat already contacted. Your other web rules still apply.";

let fixture: string | undefined;
let brain = "", origin = "";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let owner: Principal, reader: Principal;
const cookies: Record<"owner" | "reader", string> = { owner: "", reader: "" };
const hook = runtimeHookPhases("untrusted-marks-runtime");

async function child(args: string[], cwd = repo): Promise<void> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await hook.child("client-build", process);
  if (code !== 0) throw new Error(`Untrusted marks fixture preparation failed (${code}): ${out}\n${err}`);
}

beforeAll(async () => {
  if (!executablePath) return;
  await runtimePackageBuild(repo, ["ui-react", "ui-server", "core"], hook);
  fixture = await mkdtemp(resolve(tmpdir(), "odysseus-untrusted-marks-"));
  brain = resolve(fixture, "brain");
  for (const dir of ["inbox", "notes", "people/suitors"]) await mkdir(resolve(brain, dir), { recursive: true });
  const assets = resolve(fixture, "assets");
  await mkdir(assets);
  await child([process.execPath, "-e", 'const r=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!r.success){console.error(r.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/untrusted-marks-client.tsx"), assets]);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Odysseus untrusted marks</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:var(--bk-color-canvas);color:var(--bk-color-ink)}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  const backend = makeFakeBackend({ id: "marks-fixture" });
  app = await hook.phase("host-start", () => createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(fixture!, "ui.db"),
    AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1",
    HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([backend], backend.id), staticRoot: assets, observability: createRecordingObservability() }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  owner = createPrincipal(app.db, { authMethod: "password", label: "Safari on iPhone", ttlSeconds: 3600 });
  reader = createPrincipal(app.db, { authMethod: "delegated", createdBy: owner.id, label: "Telemachus agent", ttlSeconds: 3600 });
  for (const [who, principal] of [["owner", owner], ["reader", reader]] as const) {
    const signed = await generateSignedCookie("brain_ui_session", principal.id, SECRET);
    cookies[who] = signed.split(";")[0]!.slice("brain_ui_session=".length);
  }
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }));
}, 180_000);

afterAll(() => hook.phase("cleanup", async () => {
  await browser?.close();
  server?.stop(true);
  await app?.close();
  if (fixture) await rm(fixture, { recursive: true, force: true });
}));

/** The Odysseus fixture: a present Eurymachus message, Antinous's letter moved away, a hostile name, an unmarked loom note. */
beforeEach(async () => {
  if (!app) return;
  for (const path of [MESSAGE, LOOM, HOSTILE]) await writeFile(resolve(brain, path), `# ${path}\n\nA fictional note for Penelope, dated 2026-07-12.\n`);
  if (existsSync(resolve(brain, LETTER))) await rename(resolve(brain, LETTER), resolve(brain, MOVED));
  if (!existsSync(resolve(brain, MOVED))) await writeFile(resolve(brain, MOVED), "# To Penelope, from Antinous\n");
  app.db.query("DELETE FROM untrusted_marks").run();
  const seed = app.db.query("INSERT INTO untrusted_marks (path, marked_at, marked_by) VALUES (?, ?, ?)");
  seed.run(MESSAGE, JULY_12, owner.id);
  // The reader originally marked the letter; it is now missing.
  seed.run(LETTER, JULY_12, reader.id);
  seed.run(HOSTILE, JULY_11, owner.id);
});

async function open(who: "owner" | "reader", width: number, height: number, theme: "light" | "dark", zoom = 1) {
  const context = await browser!.newContext({ viewport: { width: Math.round(width / zoom), height: Math.round(height / zoom) }, deviceScaleFactor: zoom });
  await context.addCookies([{ name: "brain_ui_session", value: cookies[who], url: origin }]);
  const outside: string[] = [];
  const sent: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin !== origin) { outside.push(url); return route.abort(); }
    return route.fallback();
  });
  const page = await context.newPage();
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/files/untrusted")) sent.push(`${request.method()} ${new URL(request.url()).search}`); });
  await page.goto(`${origin}/?theme=${theme}`);
  await page.waitForFunction("window.__marks !== undefined");
  return { page, context, outside, sent };
}
async function openFile(page: Page, path: string) {
  await page.evaluate((target) => (window as unknown as { __marks: { open(path: string): Promise<void> } }).__marks.open(target), path);
  await page.waitForFunction(() => { const s = (window as unknown as { __marks: { state(): { loading: boolean } } }).__marks.state(); return !s.loading; });
  // The store switches synchronously. Wait until React has rendered this path,
  // or switching away and straight back can commit no change of path at all, so
  // the panel never rereads the file's mark (#3361).
  await page.waitForFunction(target => document.querySelector("[data-rendered-path]")?.getAttribute("data-rendered-path") === target, path);
}
const dialog = (page: Page) => page.getByRole("dialog");
const focusedName = (page: Page) => page.evaluate(() => {
  const element = document.activeElement as HTMLElement | null;
  return element ? element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "" : "";
});
async function api(who: "owner" | "reader", method: string, path: string, body?: unknown) {
  return fetch(`${origin}/api/files/untrusted${method === "PUT" ? "" : `?path=${encodeURIComponent(path)}`}`, {
    method, headers: { cookie: `brain_ui_session=${cookies[who]}`, origin, "content-type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify(body ?? { path }) } : {}),
  });
}
/** Nothing scrolls sideways and nothing in an open dialog leaves the viewport. */
async function noHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const scroller = document.scrollingElement!;
    const outside = [...document.querySelectorAll<HTMLElement>("dialog[open] [data-untrusted-body] *")].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.right > window.innerWidth + 0.5 || rect.left < -0.5);
    }).map(element => element.tagName + ":" + (element.textContent ?? "").slice(0, 30));
    return { page: scroller.scrollWidth - scroller.clientWidth, outside };
  });
  expect(JSON.stringify({ label, ...overflow })).toBe(JSON.stringify({ label, page: 0, outside: [] }));
}
async function targetsAtLeast44(page: Page, selector: string, label: string) {
  // Layout height: an opening dialog's scale animation shrinks client rects.
  // A reaching Button (#3252) keeps its kit paint and reaches 44px past it
  // under a coarse pointer; it is held to not drawing a 44px box instead, and
  // its edges are probed in the pointer lanes (`hit-reach.*.pointer.tsx`).
  const small = await page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(sel)].filter(element => element.getClientRects().length > 0)
    .map(element => ({ name: element.getAttribute("aria-label") ?? element.textContent?.trim(), height: element.offsetHeight,
      reaches: element.classList.contains("bk-hit") && element.style.minHeight !== "44px" }))
    .filter(entry => entry.height < 44 && !entry.reaches).map(({ name, height }) => ({ name, height })), selector);
  expect(JSON.stringify({ label, small })).toBe(JSON.stringify({ label, small: [] }));
}

describe.skipIf(!executablePath)("untrusted marks in the real Files panel", () => {
  for (const [width, height, theme, zoom] of [[1440, 900, "light", 1], [1440, 900, "dark", 1], [320, 640, "dark", 1], [320, 640, "light", 1], [320, 640, "dark", 2]] as const) {
    const shape = `${width}x${height} ${theme}${zoom > 1 ? " at 200%" : ""}`;

    test(`reader: marks with the exact copy and focus, sees dates only, and never a missing record (${shape})`, async () => {
      const { page, context, outside } = await open("reader", width, height, theme, zoom);
      try {
        // The entry row counts only the present marks this reader can open.
        const entry = page.locator("[data-untrusted-entry]");
        await page.waitForFunction(() => document.querySelector("[data-untrusted-entry]")?.getAttribute("aria-label")?.includes("2 files"));
        expect(await entry.getAttribute("aria-label"), "READER_COUNT_PRESENT_ONLY").toBe("Marked untrusted, 2 files");
        expect(await page.content(), "READER_DOM_NO_MISSING_PATH").not.toContain("antinous");

        await openFile(page, LOOM);
        const markButton = page.getByRole("button", { name: "Mark untrusted", exact: true });
        await markButton.waitFor();
        // Toolbar order: reveal → title → copy → mark → share → mode.
        const order = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button[aria-label], h3[data-file-title]")]
          .map(element => element.getAttribute("aria-label") ?? "title").filter(name => ["Reveal in tree", "title", "Copy path", "Mark untrusted", "Share"].includes(name)));
        expect(order.indexOf("Copy path"), "TOOLBAR_ORDER").toBeLessThan(order.indexOf("Mark untrusted"));
        await markButton.click();
        await dialog(page).getByText("Mark this file untrusted?").waitFor();
        expect(await focusedName(page), "MARK_DIALOG_FOCUS_CANCEL").toBe("Cancel");
        expect(await page.locator("[data-proxy-bullet]").textContent(), "PROXY_BULLET_EXACT").toBe(PROXY);
        const body = await dialog(page).textContent();
        expect(body).toContain("Only the owner can see or clear it then.");
        expect(body).toContain("Only the owner can clear a mark.");
        await noHorizontalScroll(page, "reader mark dialog");
        await targetsAtLeast44(page, "[data-untrusted-body] [role=button]", "reader mark dialog");
        // Escape returns to the button.
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector("dialog[open]"));
        expect(await focusedName(page), "ESCAPE_RETURNS_TO_BUTTON").toBe("Mark untrusted");

        await markButton.click();
        await dialog(page).getByRole("button", { name: "Mark untrusted" }).click();
        await page.waitForFunction(() => document.querySelector("[data-untrusted-announcer]")?.textContent === "penelope-loom.md marked untrusted");
        // The reader's button is gone: focus is on the file title, and the cue has a date and no identity.
        expect(await page.getByRole("button", { name: "Mark untrusted", exact: true }).count()).toBe(0);
        expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-file-title")), "READER_MARK_FOCUS_TITLE").toBe(true);
        const cue = await page.locator("[data-untrusted-cue]").first().textContent();
        expect(cue).toMatch(/^untrusted · marked \d{1,2} [A-Z][a-z]{2}$/);
        expect(await page.getByRole("button", { name: "Untrusted: clear mark" }).count(), "READER_NO_CLEAR").toBe(0);

        // The list: present rows only, the reader's subtitle, inert hostile text.
        if (width < 900) await page.evaluate(() => (window as unknown as { __marks: { expandTree(): void } }).__marks.expandTree());
        await page.waitForFunction(() => document.querySelector("[data-untrusted-entry]")?.getAttribute("aria-label") === "Marked untrusted, 3 files");
        await page.locator("[data-untrusted-entry]").click();
        await page.locator("[data-untrusted-heading]").waitFor();
        expect(await focusedName(page), "ENTER_LIST_FOCUS_HEADING").toBe("Marked untrusted");
        const list = page.locator("[data-untrusted-list]");
        await list.locator("[data-mark-row]").first().waitFor();
        const text = await list.textContent();
        expect(text).toContain("Files marked by you or others. Doesn't list other untrusted sources. Marks on moved or deleted files are shown to the owner.");
        expect(await list.locator("[data-mark-row]").count(), "READER_LIST_THREE_PRESENT").toBe(3);
        // The approved subtitle itself says "by you or others"; the rows carry no identity.
        const rowsText = (await list.locator("[data-mark-row]").allTextContents()).join("\n");
        for (const forbidden of ["antinous", "missing", "Safari on iPhone", "Telemachus agent", "by you", " by "]) expect(rowsText, `READER_ROWS_NO_${forbidden}`).not.toContain(forbidden);
        for (const forbidden of ["antinous", "missing", "Safari on iPhone", "Telemachus agent"]) expect(text, `READER_LIST_NO_${forbidden}`).not.toContain(forbidden);
        expect(text, "HOSTILE_PATH_LITERAL").toContain("[x](evil.invalid) <b>bold <img src=x onerror=alert(1)>.md");
        expect(await list.locator("a, b, img").count(), "HOSTILE_PATH_INERT").toBe(0);
        expect(await list.locator("[role=tree], [role=treeitem]").count(), "LIST_IS_NOT_A_TREE").toBe(0);
        expect(await list.locator("[data-mark-row] button").count(), "ROWS_HAVE_NO_NESTED_CONTROLS").toBe(0);
        await noHorizontalScroll(page, "reader list");
        await targetsAtLeast44(page, "[data-untrusted-list] :is(button, [role=button])", "reader list");
        if (width >= 900) expect(await page.getByText("j / k move").count(), "JK_HINT_SUSPENDED").toBe(0);
        await page.getByRole("button", { name: "All files" }).click();
        await page.waitForFunction(() => document.activeElement?.hasAttribute("data-untrusted-entry"));
        expect(outside).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);

    test(`owner: cue with the label, pressed clear, missing first, missing dialog and clear focus (${shape})`, async () => {
      const { page, context, outside } = await open("owner", width, height, theme, zoom);
      try {
        await openFile(page, MESSAGE);
        const clear = page.getByRole("button", { name: "Untrusted: clear mark" });
        await clear.waitFor();
        expect(await page.locator("[data-untrusted-cue]").first().textContent(), "OWNER_CUE_BY_YOU").toBe("untrusted · marked 12 Jul by you");
        if (width >= 1440) expect(await page.locator('[data-rail-block="untrusted"]').textContent(), "OWNER_RAIL").toBe("Untrusted marked 12 Julby you");

        if (width < 900) await page.evaluate(() => (window as unknown as { __marks: { expandTree(): void } }).__marks.expandTree());
        await page.waitForFunction(() => document.querySelector("[data-untrusted-entry]")?.getAttribute("aria-label") === "Marked untrusted, 3 files");
        await page.locator("[data-untrusted-entry]").click();
        const list = page.locator("[data-untrusted-list]");
        await list.locator("[data-mark-row]").first().waitFor();
        expect(await list.textContent()).toContain("Files you or others marked. Doesn't list other untrusted sources.");
        const rows = await list.locator("[data-mark-row]").evaluateAll(elements => elements.map(element => element.getAttribute("data-mark-row")));
        expect(rows, "OWNER_MISSING_FIRST_THEN_NEWEST").toEqual([LETTER, MESSAGE, HOSTILE]);
        expect(await list.locator(`[data-mark-row="${LETTER}"]`).textContent()).toContain("missing · marked 12 Jul");

        await list.locator(`[data-mark-row="${LETTER}"]`).click();
        await dialog(page).getByText("Missing file").waitFor();
        expect(await focusedName(page), "MISSING_DIALOG_FOCUS_CLOSE").toBe("Close");
        expect(await dialog(page).textContent()).toContain("brain-kit doesn't follow moves, so a moved copy is not marked.");
        await noHorizontalScroll(page, "missing dialog");
        await targetsAtLeast44(page, "[data-untrusted-body] [role=button]", "missing dialog");
        await page.locator("[data-missing-close] [role=button]").click();
        await page.waitForFunction((path) => document.activeElement?.getAttribute("data-mark-row") === path, LETTER);

        await list.locator(`[data-mark-row="${LETTER}"]`).click();
        await dialog(page).getByRole("button", { name: "Clear old mark" }).click();
        await dialog(page).getByText("Clear the old mark?").waitFor();
        expect(await focusedName(page)).toBe("Cancel");
        await dialog(page).getByRole("button", { name: "Clear old mark" }).click();
        await page.waitForFunction(() => document.querySelector("[data-untrusted-announcer]")?.textContent === "Untrusted mark cleared");
        await page.waitForFunction((path) => document.activeElement?.getAttribute("data-mark-row") === path, MESSAGE);
        expect(app!.db.query("SELECT path FROM untrusted_marks ORDER BY path").all().map(row => (row as { path: string }).path)).toEqual([HOSTILE, MESSAGE]);

        // Clearing the present mark: confirmation copy, then the same button becomes Mark.
        if (width < 900) await page.evaluate(() => (window as unknown as { __marks: { collapseTree(): void } }).__marks.collapseTree());
        await clear.click();
        await dialog(page).getByText("Clear the untrusted mark?").waitFor();
        expect(await dialog(page).textContent()).toContain("A chat can still be untrusted for other reasons.");
        await dialog(page).getByRole("button", { name: "Clear mark" }).click();
        await page.waitForFunction(() => document.querySelector("[data-untrusted-announcer]")?.textContent === "Untrusted mark cleared");
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Mark untrusted");
        expect(await page.locator("[data-untrusted-cue]").count()).toBe(0);
        // Marking as the owner: focus stays on the same button, now Clear.
        await page.getByRole("button", { name: "Mark untrusted", exact: true }).click();
        const ownerBody = await dialog(page).textContent();
        expect(ownerBody, "OWNER_DIALOG_NO_READER_LINES").not.toContain("Only the owner can clear a mark.");
        await dialog(page).getByRole("button", { name: "Mark untrusted" }).click();
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Untrusted: clear mark");
        expect(outside).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
  }

  test("races, refusals, uncertain replies and a file switch settle from the host only", async () => {
    const { page, context, sent } = await open("reader", 1440, 900, "dark");
    try {
      // Already marked: another session marks first.
      await openFile(page, LOOM);
      await page.getByRole("button", { name: "Mark untrusted", exact: true }).click();
      expect((await api("owner", "PUT", LOOM)).status).toBe(200);
      await dialog(page).getByRole("button", { name: "Mark untrusted" }).click();
      await page.waitForFunction(() => document.querySelector("[data-untrusted-announcer]")?.textContent === "This file was already marked untrusted.");
      expect(await api("owner", "DELETE", LOOM).then(response => response.json())).toEqual({ status: "cleared" });

      // A refusal keeps the dialog, with the access copy.
      await openFile(page, LOOM);
      await page.getByRole("button", { name: "Mark untrusted", exact: true }).waitFor();
      await page.route("**/api/files/untrusted", route => route.request().method() === "PUT" ? route.fulfill({ status: 403, json: { error: "forbidden" } }) : route.fallback());
      await page.getByRole("button", { name: "Mark untrusted", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Mark untrusted" }).click();
      await dialog(page).getByText("You don't have access to this file any more. Nothing was marked.").waitFor();
      await page.unroute("**/api/files/untrusted");
      await page.locator("[data-untrusted-body]").getByRole("button", { name: "Cancel" }).click();

      // A dropped reply that the host did apply: Checking…, then the host's result.
      let release: () => void = () => {};
      const held = new Promise<void>(done => { release = done; });
      await page.route("**/api/files/untrusted", async route => {
        if (route.request().method() !== "PUT") return route.fallback();
        await route.fetch();
        await held;
        return route.abort("failed");
      });
      await page.getByRole("button", { name: "Mark untrusted", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Mark untrusted" }).click();
      expect(await page.locator("[data-untrusted-cue]").count(), "NO_OPTIMISTIC_CUE").toBe(0);
      release();
      await page.waitForFunction(() => document.querySelector("[data-untrusted-announcer]")?.textContent === "penelope-loom.md marked untrusted");
      await page.unroute("**/api/files/untrusted");
      await page.locator("[data-untrusted-cue]").waitFor();
      expect(await api("owner", "DELETE", LOOM).then(response => response.json())).toEqual({ status: "cleared" });

      // A reply lost before the host saw it: nothing changed, and Try again repeats the same intent.
      await openFile(page, MESSAGE);
      await openFile(page, LOOM);
      await page.route("**/api/files/untrusted", route => route.request().method() === "PUT" ? route.abort("failed") : route.fallback());
      await page.getByRole("button", { name: "Mark untrusted", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Mark untrusted" }).click();
      await dialog(page).getByText("Couldn't reach your brain. Nothing has changed yet.").waitFor();
      // The check itself failing: Still couldn't check.
      await page.unroute("**/api/files/untrusted");
      await page.route("**/api/files/untrusted?*", route => route.abort("failed"));
      await page.route("**/api/files/untrusted", route => route.request().method() === "PUT" ? route.abort("failed") : route.fallback());
      await dialog(page).getByRole("button", { name: "Try again" }).click();
      await dialog(page).getByText("Still couldn't check. Try again.").waitFor();
      await page.unroute("**/api/files/untrusted?*");
      await page.unroute("**/api/files/untrusted");
      const before = sent.length;
      await dialog(page).getByRole("button", { name: "Try again" }).click();
      // The announcer still holds this sentence from the dropped reply above, so
      // it cannot show the retry settled. The closed dialog and the cue can: until
      // then the mark is in flight and would land after the clear below (#3457).
      await page.waitForFunction(() => !document.querySelector("dialog[open]") && !!document.querySelector("[data-untrusted-cue]"));
      await page.waitForFunction(() => document.querySelector("[data-untrusted-announcer]")?.textContent === "penelope-loom.md marked untrusted");
      expect(sent.slice(before), "RETRY_REPEATS_MARK").toEqual(["PUT "]);

      // Switching files closes the dialog and sends nothing.
      expect(await api("owner", "DELETE", LOOM).then(response => response.json()), "RETRIED_MARK_SETTLED_BEFORE_CLEAR").toEqual({ status: "cleared" });
      await openFile(page, MESSAGE);
      await openFile(page, LOOM);
      await page.getByRole("button", { name: "Mark untrusted", exact: true }).click();
      const count = sent.length;
      await openFile(page, MESSAGE);
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
      expect(sent.slice(count), "FILE_SWITCH_SENDS_NOTHING").toEqual([]);

      // Gone before marking: the viewer reloads to File not found.
      await openFile(page, LOOM);
      await page.getByRole("button", { name: "Mark untrusted", exact: true }).click();
      await rm(resolve(brain, LOOM));
      await dialog(page).getByRole("button", { name: "Mark untrusted" }).click();
      await dialog(page).getByText("There's no file at this path any more. Nothing was marked.").waitFor();
      await page.locator("[data-untrusted-body]").getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("heading", { name: "File not found", exact: true }).waitFor();
      expect(await page.locator("[data-untrusted-cue], [data-untrusted-control]").count()).toBe(0);

      // A deep link to the missing letter: File not found, no cue and no mark details.
      await openFile(page, LETTER);
      await page.getByRole("heading", { name: "File not found", exact: true }).waitFor();
      expect(await page.locator("[data-untrusted-cue], [data-untrusted-control], [data-untrusted-unknown]").count()).toBe(0);
    } finally { await context.close(); }
  }, 90_000);

  test("owner clear races and refusal: already cleared, then only-the-owner copy keeps the cue", async () => {
    const { page, context } = await open("owner", 1440, 900, "light");
    try {
      await openFile(page, MESSAGE);
      await page.getByRole("button", { name: "Untrusted: clear mark" }).click();
      expect((await api("owner", "DELETE", MESSAGE)).status).toBe(200);
      await dialog(page).getByRole("button", { name: "Clear mark" }).click();
      await page.waitForFunction(() => document.querySelector("[data-untrusted-announcer]")?.textContent === "This mark was already cleared.");
      await api("owner", "PUT", MESSAGE);
      await openFile(page, LOOM);
      await openFile(page, MESSAGE);
      await page.route("**/api/files/untrusted?*", route => route.request().method() === "DELETE" ? route.fulfill({ status: 403, json: { error: "owner_required" } }) : route.fallback());
      await page.getByRole("button", { name: "Untrusted: clear mark" }).click();
      await dialog(page).getByRole("button", { name: "Clear mark" }).click();
      await dialog(page).getByText("Only the owner can clear this mark. Nothing changed.").waitFor();
      expect(await page.locator("[data-untrusted-cue]").count(), "REFUSED_CLEAR_KEEPS_CUE").toBe(1);
    } finally { await context.close(); }
  }, 60_000);

  test("unknown, unsupported and forbidden lookups draw no control", async () => {
    const { page, context } = await open("owner", 1440, 900, "dark");
    try {
      await page.route("**/api/files/untrusted?*", route => route.fulfill({ status: 500, json: { error: "internal_error" } }));
      await openFile(page, MESSAGE);
      await page.getByText("Couldn't check the untrusted mark").waitFor();
      expect(await page.locator("[data-untrusted-control]").count(), "UNKNOWN_NO_CONTROL").toBe(0);
      await page.unroute("**/api/files/untrusted?*");
      await page.getByRole("button", { name: "Retry" }).click();
      await page.getByRole("button", { name: "Untrusted: clear mark" }).waitFor();

      await page.route("**/api/files/content?*", route => route.fulfill({ status: 403, json: { error: "forbidden" } }));
      await openFile(page, LOOM);
      await page.getByRole("heading", { name: "This file isn't available with your current access." }).waitFor();
      expect(await page.locator("[data-untrusted-cue], [data-untrusted-control], [data-untrusted-unknown]").count(), "FORBIDDEN_NO_CUE").toBe(0);
    } finally { await context.close(); }
    const unsupported = await open("owner", 1440, 900, "light");
    try {
      await unsupported.page.route("**/api/files/untrusted**", route => route.fulfill({ status: 404, contentType: "text/plain", body: "404 Not Found" }));
      const lookup = (part: string) => unsupported.page.waitForResponse(response => response.url().includes(part) && response.status() === 404);
      const list = lookup("/api/files/untrusted/list");
      await unsupported.page.reload();
      await unsupported.page.waitForFunction("window.__marks !== undefined");
      const detail = lookup(`/api/files/untrusted?path=${encodeURIComponent(MESSAGE)}`);
      await openFile(unsupported.page, MESSAGE);
      await Promise.all([list, detail]);
      await unsupported.page.getByRole("button", { name: "Copy path" }).waitFor();
      // Both lookups have been answered. An unsupported server draws nothing, so
      // no element or state change marks the answer having been rendered: this
      // window lets a wrongly drawn cue, control or entry row commit.
      await Bun.sleep(200);
      expect(await unsupported.page.locator("[data-untrusted-cue], [data-untrusted-control], [data-untrusted-unknown], [data-untrusted-entry]").count(), "UNSUPPORTED_NOTHING").toBe(0);
    } finally { await unsupported.context.close(); }
  }, 60_000);
});
