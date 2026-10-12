import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createWriterGate } from "../../ui-server/src/brain/writer-gate.js";
import { recordGovernanceEvent } from "../../ui-server/src/governance/events.js";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.js";

const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(path => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath) throw new Error("Turn journal proof requires real Chrome");
const repo = resolve(import.meta.dir, "../../.."), password = "the bow only Odysseus can string", turnId = "odysseus-journal";
let root = "", origin = "", browser: Browser, app: Awaited<ReturnType<typeof createApp>>, server: ReturnType<typeof Bun.serve>;
async function child(args: string[]) {
  const process = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`Journal fixture build failed (${code})\n${out}${err}`);
}
beforeAll(async () => {
  if (process.env.BRAIN_JOURNAL_DEPENDENCIES_BUILT !== "1") await child([process.execPath, "scripts/build.ts"]);
  root = await mkdtemp(resolve(tmpdir(), "odysseus-journal-browser-"));
  const brain = resolve(root, "brain"), assets = resolve(root, "assets");
  await createFixtureBrain(repo, brain); await mkdir(assets);
  await writeFile(resolve(brain, "notes/voyage.md"), "Ithaca\r\n");
  await child([process.execPath, "-e", 'const result=await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"});if(!result.success){console.error(result.logs);process.exit(1)}', resolve(import.meta.dir, "fixtures/turn-journal-client.tsx"), assets]);
  const backend = makeFakeBackend({ id: "journal-fixture" });
  app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), AUTH_MODE: "password", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(password), COOKIE_SECRET: "odysseus-journal-cookie-secret-0123456789", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), staticRoot: assets, observability: createRecordingObservability() });
  app.wsHost.journal!.begin(turnId, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  await writeFile(resolve(brain, "notes/voyage.md"), "Athena charts the return.\r\n");
  app.db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Homeward',1,1)").run();
  for (const decision of ["approved", "declined"] as const) recordGovernanceEvent(app.db, { kind: "outward_action", sessionId: "ithaca", turnId, actor: "interactive", model: null, profile: "governed",
    payload: { tool: "Bash", input: JSON.stringify({ command: "git push origin main" }), inputTruncated: false, action: "git_push", target: "github.com/odysseus/voyage.git", historyRewrite: false, tainted: false, decision, rule: null } });
  app.wsHost.journal!.finish(turnId);
  const seed = JSON.stringify({ turnId, summary: app.wsHost.journal!.summary(turnId) });
  await writeFile(resolve(assets, "index.html"), `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odysseus journal</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;background:var(--bk-color-canvas);color:var(--bk-color-ink)}main{padding:16px;max-width:900px}textarea{max-width:100%}</style></head><body><div id="app"></div><script>window.__journalSeed=${seed}</script><script type="module" src="/client.js"></script></body></html>`);
  for (const [name, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) await writeFile(resolve(assets, name!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket }); origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 180_000);
afterAll(async () => { await browser?.close(); server?.stop(true); await app?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function scene(width = 1280, theme = "dark", replay = false) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" }), outside: string[] = [];
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : (outside.push(route.request().url()), route.abort()));
  expect((await context.request.post(`${origin}/api/auth/login`, { data: { password } })).status()).toBe(200);
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/?${new URLSearchParams({ theme, ...(replay ? { replay: "1" } : {}) })}`);
  try { await page.getByRole("button", { name: /changed file/ }).waitFor({ timeout: 5000 }); }
  catch { const body = await page.locator("body").innerText(); await context.close(); throw new Error(`Journal scene failed: ${body}; ${errors.join("; ")}`); }
  return { context, page, outside };
}
for (const width of [320, 1280]) for (const theme of ["dark", "light"]) for (const replay of [false, true]) test(`journal ${replay ? "replay" : "live"} ${theme} ${width} starts collapsed and reviews raw versions with stable keyboard focus`, async () => {
  const { context, page, outside } = await scene(width, theme, replay);
  try {
    const disclosure = page.getByRole("button", { name: /changed file/ });
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect((await disclosure.boundingBox())!.height, "JOURNAL_DISCLOSURE_44PX").toBeGreaterThanOrEqual(44);
    await page.getByRole("textbox", { name: "Message" }).focus();
    await page.evaluate(id => (window as any).__journalFixture.frame({ type: "turn_journal", sessionId: "ithaca", turnId: id, journal: (window as any).__journalSeed.summary }), turnId);
    expect(await page.getByRole("textbox", { name: "Message" }).evaluate(element => document.activeElement === element), "JOURNAL_ARRIVAL_NEVER_STEALS_FOCUS").toBe(true);
    expect(await page.evaluate(() => (window as any).__journalFixture.state().streaming), "JOURNAL_RECEIPT_NEVER_REOPENS_TURN").toBe(false);
    expect(await page.evaluate(() => (window as any).__journalFixture.state().runState), "JOURNAL_RECEIPT_NEVER_REOPENS_RUN_STATE").toBe("idle");
    await disclosure.focus(); await page.keyboard.press("Enter");
    const review = page.getByRole("button", { name: "Review notes/voyage.md", exact: true }); await review.waitFor();
    expect(await page.getByRole("heading", { name: "Outward actions", exact: true }).count(), "OUTWARD_JOURNAL_IRREVERSIBLE_VISIBLE").toBe(1);
    expect(await page.getByText("These receipts record approval, not external completion. External actions are irreversible here; restoring local files cannot undo them.", { exact: true }).count(), "OUTWARD_JOURNAL_TRUTHFUL_SCOPE").toBe(1);
    expect(await page.getByText("Git push · Approved · github.com/odysseus/voyage.git", { exact: true }).count()).toBe(1);
    expect(await page.getByText("Git push · Declined · github.com/odysseus/voyage.git", { exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: /Revert.*push/i }).count(), "OUTWARD_JOURNAL_NO_REVERT").toBe(0);
    await review.focus(); await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Retained change", exact: true }).waitFor();
    await page.getByText("Athena charts the return.", { exact: true }).waitFor();
    expect(await page.getByRole("heading", { name: "notes/voyage.md", exact: true }).evaluate(element => document.activeElement === element), "JOURNAL_READER_HEADING_FOCUS").toBe(true);
    await page.getByRole("button", { name: "Revert notes/voyage.md", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Revert notes/voyage.md", exact: true }).count()).toBe(1);
    const download = page.getByRole("link", { name: /Download before/ });
    expect(await download.evaluate(async element => { const response = await fetch((element as HTMLAnchorElement).href); return { status: response.status, text: await response.text() }; })).toEqual({ status: 200, text: "Ithaca\r\n" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "JOURNAL_RESPONSIVE_BOUNDS").toBe(true);
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "JOURNAL_ZOOM_BOUNDS").toBe(true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Review notes/voyage.md");
    expect(await disclosure.getAttribute("aria-expanded"), "JOURNAL_ESCAPE_ONLY_CLOSES_READER").toBe("true");
    expect(outside).toEqual([]);
  } finally { await context.close(); }
});
test("journal stale-session responses and expired receipts expose no retained reader actions", async () => {
  const { context, page } = await scene();
  try {
    const disclosure = page.getByRole("button", { name: /changed file/ }); await disclosure.click();
    await page.getByRole("button", { name: "Review notes/voyage.md", exact: true }).waitFor();
    await page.evaluate(id => (window as any).__journalFixture.frame({ type: "turn_journal", sessionId: "ithaca", turnId: id, journal: { ...(window as any).__journalSeed.summary, state: "expired" } }), turnId);
    await page.getByText("Retained details expired. Raw versions and review actions are unavailable.", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: /Review notes/ }).count()).toBe(0);
    await page.evaluate(() => (window as any).__journalFixture.switchSession());
    expect(await page.getByRole("dialog").count()).toBe(0);
  } finally { await context.close(); }
});

test("whole-turn review reads first; Escape has no effect, waiting receipt stays beneath the turn, and Undo uses the same stale-safe flow", async () => {
  const { context, page, outside } = await scene(320, "light", true);
  const hold = await createWriterGate(app.db, resolve(root, "brain")).acquire("shared", "turn:athena", { turn: true });
  try {
    await page.getByRole("button", { name: /changed file/ }).click();
    const trigger = page.getByRole("button", { name: "Review whole-turn revert", exact: true }); await trigger.waitFor();
    await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Review history operation", exact: true }); await dialog.waitFor();
    expect(await page.getByRole("heading", { name: "Review whole-turn revert", exact: true }).evaluate(element => document.activeElement === element), "REVERT_REVIEW_READING_FOCUS").toBe(true);
    await page.keyboard.press("Escape"); await dialog.waitFor({state:"hidden"});
    await page.waitForFunction(()=>document.activeElement?.textContent === "Review whole-turn revert");
    expect(await readFile(resolve(root,"brain/notes/voyage.md"),"utf8"), "REVERT_ESCAPE_NEVER_EXECUTES").toBe("Athena charts the return.\r\n");
    await trigger.click();const commit=page.getByRole("button",{name:"Revert 1 file",exact:true});expect((await commit.boundingBox())!.height).toBeGreaterThanOrEqual(44);await commit.click();
    await page.getByText("Waiting for running turns.",{exact:true}).waitFor();
    expect(await page.locator("[data-turn-journal] [data-revert-receipt='waiting']").count(),"REVERT_RECEIPT_SAME_DISCLOSURE").toBe(1);
    expect(await page.getByRole("button",{name:/Cancel revert|Cancel operation/}).count()).toBe(0);
    hold.release();
    await page.waitForFunction(()=>!["waiting","applying"].includes(document.querySelector("[data-revert-receipt]")?.getAttribute("data-revert-receipt") ?? "waiting"), {timeout:10000});
    expect(await page.locator("[data-revert-receipt]").getAttribute("data-revert-receipt"), await page.locator("[data-revert-receipt]").innerText()).toBe("partial");
    expect(await page.locator("[data-revert-receipt]").innerText(), "REVERT_EXCLUDED_IGNORED_PATH_NAMED").toContain("excluded (version_unavailable)");
    expect(await readFile(resolve(root,"brain/notes/voyage.md"),"utf8"),"REVERT_BROWSER_ORIGINAL_BYTES").toBe("Ithaca\r\n");
    await page.getByRole("button",{name:"Undo",exact:true}).click();await page.getByRole("heading",{name:"Review Undo",exact:true}).waitFor();await page.getByRole("button",{name:"Revert 1 file",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector("[data-revert-receipt]")?.getAttribute("data-revert-receipt")==="complete");
    expect(await readFile(resolve(root,"brain/notes/voyage.md"),"utf8"),"REVERT_BROWSER_UNDO_BYTES").toBe("Athena charts the return.\r\n");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"REVERT_PHONE_BOUNDS").toBe(true);expect(outside).toEqual([]);
  } finally { hold.release(); await context.close(); }
});

test("a lost POST response reconciles its original operation without another write", async () => {
  const { context, page } = await scene(); let posts=0;
  try {
    await context.route("**/turns/*/revert",async route=>{if(route.request().method()!=="POST")return route.continue();posts++;await route.fetch();await route.abort("failed");});
    await page.getByRole("button",{name:/changed file/}).click();await page.getByRole("button",{name:"Review notes/voyage.md",exact:true}).click();
    await page.getByRole("button",{name:"Revert notes/voyage.md",exact:true}).click();await page.getByText("The response was not confirmed. Check the original receipt; no action will be retried automatically.",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Close",exact:true}).click();await page.getByRole("button",{name:"Check again",exact:true}).click();await page.locator("[data-revert-receipt='complete']").waitFor();
    expect(posts,"REVERT_LOST_RESPONSE_NO_BLIND_RETRY").toBe(1);expect(await readFile(resolve(root,"brain/notes/voyage.md"),"utf8")).toBe("Ithaca\r\n");
    await context.unroute("**/turns/*/revert");await page.getByRole("button",{name:"Undo",exact:true}).click();await page.getByRole("button",{name:"Revert 1 file",exact:true}).click();await page.locator("[data-revert-receipt='complete']").waitFor();
    expect(await readFile(resolve(root,"brain/notes/voyage.md"),"utf8")).toBe("Athena charts the return.\r\n");
  } finally { await context.close(); }
});

test("stale bytes skip the reviewed path and a refused journal produces a named failed receipt without Undo", async () => {
  const { context, page } = await scene(320, "dark", true);
  try {
    await page.getByRole("button",{name:/changed file/}).click();await page.getByRole("button",{name:"Review notes/voyage.md",exact:true}).click();
    await writeFile(resolve(root,"brain/notes/voyage.md"),"Penelope's later work\r\n");await page.getByRole("button",{name:"Revert notes/voyage.md",exact:true}).click();await page.getByRole("button",{name:"Close",exact:true}).click();
    await page.locator("[data-revert-receipt='partial']").waitFor();expect(await page.locator("[data-revert-receipt]").innerText(),"REVERT_BROWSER_CONFLICT_NAMED").toContain("notes/voyage.md: conflict");expect(await readFile(resolve(root,"brain/notes/voyage.md"),"utf8")).toBe("Penelope's later work\r\n");expect(await page.getByRole("button",{name:"Undo",exact:true}).count()).toBe(0);
    await writeFile(resolve(root,"brain/notes/voyage.md"),"Athena charts the return.\r\n");
    app.db.exec("CREATE TRIGGER refuse_user_journal BEFORE INSERT ON turn_journal_manifests WHEN NEW.turn_id LIKE 'revert_%' BEGIN SELECT RAISE(ABORT,'fixture user journal unavailable'); END");
    await page.getByRole("button",{name:"Review notes/voyage.md",exact:true}).click();await page.getByRole("button",{name:"Revert notes/voyage.md",exact:true}).click();await page.getByRole("button",{name:"Close",exact:true}).click();await page.locator("[data-revert-receipt='failed']").waitFor();
    expect(await readFile(resolve(root,"brain/notes/voyage.md"),"utf8"),"REVERT_FAILED_ADMISSION_NO_EFFECT").toBe("Athena charts the return.\r\n");expect(await page.getByRole("button",{name:"Undo",exact:true}).count()).toBe(0);
  } finally { app.db.exec("DROP TRIGGER IF EXISTS refuse_user_journal");await writeFile(resolve(root,"brain/notes/voyage.md"),"Athena charts the return.\r\n");await context.close(); }
});

test("voice and expired facts remove actions; an old POST response cannot attach its receipt to another session", async () => {
  const { context, page } = await scene(); const hold=await createWriterGate(app.db,resolve(root,"brain")).acquire("shared","turn:athena",{turn:true});let releaseResponse:(()=>void)|undefined;
  try {
    await page.getByRole("button",{name:/changed file/}).click();await page.getByRole("button",{name:"Review whole-turn revert",exact:true}).waitFor();
    await page.evaluate(id=>(window as any).__journalFixture.frame({type:"turn_journal",sessionId:"ithaca",turnId:id,journal:{...(window as any).__journalSeed.summary,actor:"voice"}}),turnId);
    expect(await page.getByRole("button",{name:"Review whole-turn revert",exact:true}).count(),"REVERT_VOICE_SURFACE_INACTIVE").toBe(0);
    await page.evaluate(id=>(window as any).__journalFixture.frame({type:"turn_journal",sessionId:"ithaca",turnId:id,journal:{...(window as any).__journalSeed.summary,state:"expired"}}),turnId);
    expect(await page.getByRole("button",{name:/Revert|Undo/}).count(),"REVERT_EXPIRED_SURFACE_INACTIVE").toBe(0);
    await page.evaluate(id=>(window as any).__journalFixture.frame({type:"turn_journal",sessionId:"ithaca",turnId:id,journal:(window as any).__journalSeed.summary}),turnId);
    await context.route("**/turns/*/revert",async route=>{if(route.request().method()!=="POST")return route.continue();const response=await route.fetch();await new Promise<void>(resolve=>{releaseResponse=resolve;});await route.fulfill({response});});
    await page.getByRole("button",{name:"Review notes/voyage.md",exact:true}).click();await page.getByRole("button",{name:"Revert notes/voyage.md",exact:true}).click();
    for(let attempts=0;!releaseResponse&&attempts<100;attempts++)await Bun.sleep(10);expect(releaseResponse).toBeDefined();
    await page.evaluate(()=>(window as any).__journalFixture.switchSession());releaseResponse!();hold.release();await page.waitForTimeout(100);
    expect(await page.locator("[data-revert-receipt]").count(),"REVERT_STALE_SESSION_RESPONSE_IGNORED").toBe(0);expect(await page.getByRole("dialog").count()).toBe(0);
  } finally {releaseResponse?.();hold.release();await context.close();}
});
