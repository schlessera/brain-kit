import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type Page, type Locator } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { generateWav, AUDIO_FIXTURES } from "./browser/offline/audio-fixtures.ts";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// Association and sign-out (#1022): real password routes and IndexedDB.
// Each matrix cell owns its browser context. Held native writes, a second tab
// and composed Settings/Dictation handlers exercise deletion and modal races.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && !process.env.BRAIN_PINNED_CHROMIUM && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Local work runtime proof requires real Chrome");
if (!executablePath && !process.env.BRAIN_PINNED_CHROMIUM) console.warn("SKIPPING local work runtime proof: no Chrome; device-local drafts are unverified in a browser locally.");

const repo = resolve(import.meta.dir, "../../..");
const PASSWORD = "the bow only Odysseus can string";
const SESSION = "odysseus-ithaca";
const runtimeTest = test.skipIf(!executablePath && !process.env.BRAIN_PINNED_CHROMIUM);
let browser: Browser | undefined;
let scratch: string | undefined;
let brain = "";
let assets = "";
let passwordHash = "";
let port = 0;
let origin = "";
type Host = { app: Awaited<ReturnType<typeof createApp>>; server: ReturnType<typeof Bun.serve> };
let host: Host | undefined;

// A long conversation, so the transcript scrolls and its place means something.
const transcript: SessionHistoryMessage[] = Array.from({ length: 24 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: i % 2 === 0
    ? `Question ${i / 2 + 1}: which harbour after Aeolus' island?`
    : `Answer ${(i + 1) / 2}. ${"The winds were loosed from the bag, and the ships were driven back past every headland they had rounded. ".repeat(6)}`,
  toolCalls: [],
}));

/** One host: its own UI database, so its own account partition key. */
async function startHost(db: string): Promise<Host> {
  const backend: AgentBackend = {
    id: "local-scripted", capabilities: { resume: true, permissions: false, thinking: false, attachments: true, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "local-scripted", label: "Local fixture" }],
    listSessions: async () => [{ id: SESSION, title: "Winds of Aeolus", createdAt: 1, lastActiveAt: Date.now(), totalCostUsd: 0, numTurns: 12 }],
    getHistory: async () => structuredClone(transcript),
    async startTurn({ bridge, sessionId }) {
      bridge.emit({ type: "session_info", sessionId: sessionId ?? SESSION, isNew: false });
      bridge.emit({ type: "result", sessionId: sessionId ?? SESSION, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  const app = await createApp({
    config: resolveServerConfig({
      BRAIN_PATH: brain, DB_PATH: resolve(scratch!, db), AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: passwordHash,
      COOKIE_SECRET: "odysseus-association-signout-cookie-secret-0123456789", HOST: "127.0.0.1", NODE_ENV: "test",
      BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0",
    }),
    staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), turnTimeoutMs: 60_000,
  });
  // The same port every time: one origin, so one IndexedDB, as one browser sees one host replaced by another.
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, websocket: app.websocket });
  port = server.port!;
  origin = `http://127.0.0.1:${port}`;
  return { app, server };
}
async function stopHost(h: Host | undefined) {
  if (!h) return;
  h.server.stop(true);
  h.app.cancelActiveTurns();
  await h.app.close();
}

beforeAll(async () => {
  if (!executablePath && !process.env.BRAIN_PINNED_CHROMIUM) return;
  if (!process.env.BRAIN_AUTH_FIXTURE_BUILT) {
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Local work fixture package build failed (${code}): ${out}\n${err}`);
  }
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-association-signout-"));
  brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/association-signout-client.tsx"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Local work client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  await writeFile(resolve(assets, "signout-worker.js"), 'self.addEventListener("install",event=>event.waitUntil(caches.open("odysseus-signout-shell").then(cache=>cache.addAll(["/","/client.js","/kit.css","/app.css"]))));self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));self.addEventListener("fetch",event=>{if(new URL(event.request.url).pathname.startsWith("/api/"))return;event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));});');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }

  await writeFile(resolve(scratch, "ithaca.gpx"), '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Approaching Ithaca</name><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon="0.001"/></trkseg></trk></gpx>');
  await writeFile(resolve(scratch, "microphone.wav"), generateWav(AUDIO_FIXTURES.note10s));
  passwordHash = await Bun.password.hash(PASSWORD);
  host = await startHost("ithaca.db");
  browser = await chromium.launch({ ...(process.env.BRAIN_PINNED_CHROMIUM ? {} : { executablePath }), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${resolve(scratch!, "microphone.wav")}`, "--autoplay-policy=no-user-gesture-required"], timeout: 120_000 });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await stopHost(host);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});


type Work = {
  key(): string | null; ready(): Promise<void>; held(): boolean;
  read(partition: string): Promise<Array<{ key: string; value: unknown }>>;
  rows(partition: string): Promise<Array<{ id: string; bytes: number; partition: string }>>;
  sizes(): Promise<Array<{partition:string;records:number}>>;
  seed(partition:string,id:string,transcript?:boolean): Promise<void>;
  edit(): Promise<void>; stage(): void; receipt(partition:string):Promise<void>; extra(partition:string): Promise<void>;
  assign(id:string):Promise<string>; move(from:string,to:string,keys:string[]):Promise<string>;
  refresh():void; quota():void; restore():void; clearFailure():void;
  fullDiscard(id:string):Promise<string>; reopenUnassigned():Promise<void>;
  authorize():Promise<void>; tryStale():boolean; authExpire():Promise<void>;
  compose():void; background():{settingsClosed:number;dictationCancelled:number;finalText:string;partial:string};
  live(kind:"final"|"partial"|"draining"):void;
  pendingTranscript():Promise<void>; pendingInventory():Promise<void>; release():void; pendingDone():Promise<unknown>;
  dirty():void; snapshot():Promise<string>; holdWriter():Promise<void>; snapshots():number; staleWrite():Promise<string>; staleNative():Promise<string>; staleNativeMove():Promise<string>;
  vpn():string; probe():void; draftTexts():string[]; pending():boolean;
  prepareUnassignedClear():void; staleUnassignedClear():Promise<string>; clearUnassigned():Promise<void>; unassignedClosed():Promise<boolean>;
  stageAdmission():Promise<void>; finishStaleAdmission():Promise<string>;
  holdRecordingLock():Promise<void>; lockHeld():boolean; releaseRecordingLock():void;
  captureUnassigned():Promise<void>; captureActive():{id:string;partition:string}|null; stopCapture():Promise<void>;
  failUnassignedClear():void; holdUnassignedWriter():Promise<void>; staleUnassignedWrite():Promise<string>;
  recoveryAction(action:"associate"|"discard"|"transcript",id:string):Promise<string>;
  mountColdReader(delayStorage?:boolean):Promise<void>; coldKey():string|null; coldPlayback():Promise<void>; coldPlayable():Promise<boolean>;
  stageColdPlayback():Promise<void>; releaseColdPlayback():Promise<string>;
  stageColdTranscript():Promise<void>; coldRecovery():Promise<string>; releaseColdTranscript():Promise<string>;
  stageUnassignedClear():void; clearWaiting():boolean; releaseUnassignedClear():void; coldRefreshes():number;
  flushColdStorage():void;
  coldStart():Promise<void>; coldActive():{id:string;partition:string}|null; coldStop():Promise<void>; cacheShell():Promise<void>;
  replaceRoot():Promise<void>; replacementReady():boolean; replacementHasSignIn():boolean;
  holdPeerQuery():void; peerQueryWaiting():boolean; releasePeerQuery():void;
};
declare global { interface Window { __work: Work } }
async function work<T>(page: Page, fn: (w: Work) => T): Promise<Awaited<T>> { return await page.evaluate(fn, await page.evaluateHandle(() => window.__work)) as Awaited<T>; }
async function settled(page: Page) {
  await page.waitForFunction(() => !document.getAnimations().some(a => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity));
}
async function boot(width = 390, theme = "dark", coarse = false) {
  const context = await browser!.newContext({ viewport: {width,height:900}, hasTouch: coarse, reducedMotion: "reduce" });
  await context.addInitScript(({ theme }) => { document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.theme = theme; }); }, {theme});
  const page = await context.newPage();
  const blocked: string[] = [];
  const hostWrites: string[] = [];
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) { if (!["GET","HEAD","OPTIONS"].includes(route.request().method())) hostWrites.push(`${route.request().method()} ${url.pathname}`); return route.continue(); }
    blocked.push(url.href); return route.abort();
  });
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__work);
  await page.locator('input[type=password]').waitFor();
  return { page, context, blocked, hostWrites };
}
async function signIn(page: Page) {
  await settled(page);
  await page.locator('input[type=password]').fill(PASSWORD);
  const navigation = page.waitForNavigation();
  await act(page, page.getByRole("button", {name:"Sign in",exact:true}));
  await navigation;
  await page.waitForFunction(() => !!window.__work?.key());
  await work(page, w => w.ready());
  await settled(page);
}
async function act(page: Page, control: Locator) { await settled(page); if (await page.evaluate(() => matchMedia("(pointer:coarse)").matches)) await control.tap(); else await control.click(); }
async function click(page: Page, name: string) { await act(page, page.getByRole("button", {name,exact:true})); }
async function accessible(page: Page, dialog: Locator) {
  const targets = await dialog.locator('[role=button],[role=checkbox]').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return {width:r.width,height:r.height}; }));
  expect(targets.length, "dialog has actual controls").toBeGreaterThan(0);
  expect(targets.every(r => r.width >= 44 && r.height >= 44), "all dialog targets measure at least 44 by 44").toBe(true);
  await page.addScriptTag({path: resolve(repo,"node_modules/axe-core/axe.min.js")});
  const failures = await page.evaluate(async () => {
    const axe = (window as unknown as {axe:typeof import("axe-core")}).axe;
    return (await axe.run(document.querySelector("dialog")!, {runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map(v => ({id:v.id,nodes:v.nodes.map(n=>n.target)}));
  });
  expect(failures, "dialog meets scoped WCAG A/AA checks in the real browser").toEqual([]);
}
const association = (page: Page) => page.getByRole("dialog", { name: "Drafts recorded before you signed in" });
async function associationShown(page: Page) { await association(page).waitFor(); await association(page).getByRole("checkbox").first().waitFor(); }
const signout = (page: Page) => page.getByRole("dialog", { name: "Sign out of Brain?" });
async function assertEmpty(page: Page, key: string) {
  const records = await page.evaluate(key => window.__work.read(`account:${key}`), key);
  expect(records, "every account record, including orphan chunks, receipts and work snapshots, is deleted").toEqual([]);
  const sizes = await work(page, w => w.sizes());
  expect(sizes.filter(s => s.partition === `account:${key}`), "account size ledger is empty too").toEqual([]);
}

for (const width of [320,390,900,1280]) for (const theme of ["dark","light"]) for (const coarse of [false,true]) {
  runtimeTest(`explicit association and scoped sign-out ${width}px ${theme} ${coarse ? "coarse" : "fine"}`, async () => {
    const {page,context,blocked,hostWrites} = await boot(width,theme,coarse);
    try {
      expect(await page.evaluate(() => innerWidth), "actual viewport width").toBe(width);
      expect(await page.evaluate(() => matchMedia("(pointer:coarse)").matches), "actual pointer matches the cell").toBe(coarse);
      await work(page, async w => { await w.seed("unassigned","sirens"); await w.seed("unassigned","aeolus"); await w.seed("account:nestor","pylos",true); });
      await signIn(page);
      const key = (await work(page,w=>w.key()))!;
      await associationShown(page);
      if (process.env.BRAIN_REVIEW_CAPTURES) await page.screenshot({path: `${process.env.BRAIN_REVIEW_CAPTURES}/association-${width}-${theme}-${coarse ? "coarse" : "fine"}.png`});
      await accessible(page, association(page));
      expect(await page.evaluate(() => document.activeElement?.tagName), "association initially focuses its title").toBe("H2");
      expect(await association(page).locator('[role=checkbox][aria-checked=true]').count(), "association selects nothing by default").toBe(0);
      expect(await work(page,w=>w.held()), "association holds update reload").toBe(true);
      await click(page,"Not now");
      expect((await work(page,w=>w.rows("unassigned"))).map(r=>r.id).sort(), "Not now leaves both unassigned").toEqual(["aeolus","sirens"]);
      await page.reload(); await page.waitForFunction(()=>!!window.__work?.key()); await settled(page);
      expect(await association(page).count(), "reload in the same sign-in never repeats the association sheet").toBe(0);
      await act(page,page.locator('[data-recordings-tray] button'));
      await act(page,page.getByRole("button",{name:"Play recording from 09:00, 0 minutes 10 seconds"}));
      await page.locator("audio").waitFor();
      await page.waitForFunction(()=>document.querySelector("audio")!.readyState>=2);
      expect(await page.evaluate(()=>document.querySelector("audio")!.duration), "unassigned audio remains playable after Not now and reload").toBeGreaterThan(0);
      const writesBeforeAssociation = hostWrites.length;
      await act(page,page.getByRole("button", {name:"Add to my account…",exact:true}).first());
      await associationShown(page);
      expect(await association(page).locator('[role=checkbox][aria-checked=true]').count(), "manual association also starts with no selection").toBe(0);
      await act(page,association(page).getByRole("checkbox", {name:"Add recording from 09:00, 0 minutes 10 seconds"}));
      await click(page,"Add selected to my account");
      await page.waitForFunction(()=>!document.querySelector("dialog"));
      expect(hostWrites.slice(writesBeforeAssociation), "association makes no host upload or transcription request").toEqual([]);
      expect((await work(page,w=>w.rows("unassigned"))).map(r=>r.id), "exactly the unselected recording remains unassigned").toEqual(["aeolus"]);
      expect((await page.evaluate(key=>window.__work.rows(`account:${key}`),key)).map(r=>r.id), "only explicitly selected recording enters the account").toEqual(["sirens"]);
      await act(page,page.getByRole("button",{name:"Add to my account…",exact:true})); await associationShown(page);
      expect(await association(page).getByRole("checkbox").count(),"account-bound recordings are never offered in association").toBe(1);
      expect(await association(page).getByRole("checkbox",{name:"Add recording from 10:00, 0 minutes 10 seconds"}).count(),"only the remaining unassigned recording is offered").toBe(1);
      await click(page,"Not now");
      expect(await work(page,w=>w.assign("sirens")), "an account recording cannot be reassigned by assign").not.toBe("ok");
      expect(await page.evaluate(key=>window.__work.move(`account:${key}`,"unassigned",["recording:index:sirens"]),key), "the exported partition move refuses account-to-unassigned transfer").toBe("PartitionRefusedError");
      await page.evaluate(async key=>{await window.__work.seed(`account:${key}`,"sirens",true); await window.__work.seed(`account:${key}`,"laertes",true); await window.__work.receipt(`account:${key}`); await window.__work.extra(`account:${key}`); await window.__work.edit(); window.__work.stage();},key);
      const unassignedBefore = await work(page,w=>w.read("unassigned"));
      const otherBefore = await work(page,w=>w.read("account:nestor"));
      await click(page,"Sign out everywhere"); await signout(page).waitFor();
      if (process.env.BRAIN_REVIEW_CAPTURES) await page.screenshot({path: `${process.env.BRAIN_REVIEW_CAPTURES}/signout-${width}-${theme}-${coarse ? "coarse" : "fine"}.png`});
      await accessible(page,signout(page));
      const content = await signout(page).innerText();
      expect(content, "warning counts recordings and unaccepted transcripts").toContain("1 recordings not yet added to a draft · 0.3 MB · 1 with an unaccepted transcript");
      expect(content, "warning counts accepted receipts separately").toContain("1 accepted recordings awaiting cleanup");
      expect(content, "warning counts unsent drafts").toContain("1 unsent drafts");
      expect(content, "warning includes the staged references lost on reload").toContain("1 staged track references");
      expect(await signout(page).getByRole("checkbox").isChecked(), "unassigned deletion is unticked by default").toBe(false);
      expect(await page.evaluate(()=>document.activeElement?.textContent?.trim()), "Keep working has default focus").toBe("Keep working");
      expect(await work(page,w=>w.held()), "sign-out dialog holds update reload").toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), "dialog fits the viewport").toBe(true);
      await click(page,"Keep working");
      expect((await page.evaluate(key=>window.__work.rows(`account:${key}`),key)).length, "cancel never deletes account work").toBe(2);
      await click(page,"Sign out everywhere"); await signout(page).waitFor();
      const navigation = page.waitForNavigation(); await click(page,"Sign out and delete"); await navigation;
      await page.locator('input[type=password]').waitFor(); await page.waitForFunction(()=>!!window.__work);
      expect(await page.locator("body").innerText(), "post-sign-out screen reports the retained unassigned count").toContain("1 recordings not linked to any account are still on this device.");
      await assertEmpty(page,key);
      expect(await work(page,w=>w.read("unassigned")), "unticked keeps the complete unassigned metadata and audio bytes").toEqual(unassignedBefore);
      expect(await work(page,w=>w.read("account:nestor")), "another account partition remains byte-for-byte unchanged").toEqual(otherBefore);
      expect(blocked, "no external browser egress").toEqual([]);
    } finally { await context.close(); }
  },60_000);
}

runtimeTest("association failure keeps the selected recording and leaves other recordings untouched",async()=>{
  const {page,context}=await boot();
 try { await work(page,async w=>{await w.seed("unassigned","sirens");await w.seed("unassigned","aeolus");}); await signIn(page); await associationShown(page);
 const before=await work(page,w=>w.read("unassigned")); await association(page).getByRole("checkbox").first().check(); await work(page,w=>w.quota()); await click(page,"Add selected to my account");
 await association(page).getByRole("alert").waitFor(); await work(page,w=>w.restore());
 expect(await work(page,w=>w.read("unassigned")),"failed association retains the complete source and untouched sibling").toEqual(before);
 expect(await work(page,w=>w.rows(`account:${w.key()}`)),"failed association adds nothing to the account").toEqual([]);
 }finally{await context.close();}
},30_000);

runtimeTest("ticked unassigned deletion clears it; no pending work signs out without a dialog",async()=>{
  const {page,context}=await boot();
 try { await work(page,w=>w.seed("unassigned","sirens")); await signIn(page);await associationShown(page);await click(page,"Not now");const key=(await work(page,w=>w.key()))!;
 await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();
 let navigation=page.waitForNavigation();await click(page,"Sign out and delete");await navigation;await page.waitForFunction(()=>!!window.__work);
 expect(await work(page,w=>w.read("unassigned")),"ticked deletes all unassigned records").toEqual([]);await assertEmpty(page,key);
 await signIn(page); navigation=page.waitForNavigation();await click(page,"Sign out everywhere");await page.waitForFunction(()=>!!document.querySelector("dialog")||!!document.querySelector('input[type=password]'));
 expect(await signout(page).count(),"no local work needs no sign-out dialog").toBe(0); await navigation;
 await page.locator('input[type=password]').waitFor();expect(await signout(page).count(),"no local work needs no dialog").toBe(0);
 }finally{await context.close();}
},30_000);

runtimeTest("partition clearing failure still reaches real logout and reports the failure after reload",async()=>{
  const {page,context}=await boot();
 try {await signIn(page);await work(page,w=>w.edit());await click(page,"Sign out everywhere");await signout(page).waitFor();await work(page,w=>w.clearFailure());
 const navigation=page.waitForNavigation();await click(page,"Sign out and delete");await navigation;await page.getByText(/could not be completely cleared/).waitFor();
 expect(await page.locator("body").innerText(),"failed clearing is reported on the signed-out screen").toContain("could not be completely cleared");
 expect(await page.evaluate(async () => (await fetch("/api/vpn-check")).status),"logout completed against the real auth route despite storage failure").toBe(401);
 }finally{await context.close();}
},30_000);

runtimeTest("auth expiry makes an open sign-out authorization stale and preserves account work",async()=>{
 const {page,context}=await boot();
 try {await signIn(page);await work(page,w=>w.edit());const key=(await work(page,w=>w.key()))!;await click(page,"Sign out everywhere");await signout(page).waitFor();
 await work(page,w=>w.authorize()); await work(page,w=>w.authExpire());await page.locator('input[type=password]').waitFor();
 expect(await signout(page).count(),"auth expiry removes the protected dialog").toBe(0);
 expect(await work(page,w=>w.tryStale()),"a stale account authorization never starts deletion or logout").toBe(false);
 expect((await page.evaluate(key=>window.__work.read(`account:${key}`),key)).length,"auth expiry does not clear retained drafts").toBeGreaterThan(0);
 }finally{await context.close();}
},30_000);

for (const kind of ["final","partial","draining"] as const) runtimeTest(`sign-out warns about ${kind} dictation before deleting it`,async()=>{
  const {page,context}=await boot(1280);
  try { await signIn(page); await page.evaluate(kind=>window.__work.live(kind),kind); await click(page,"Sign out everywhere");
    await page.waitForFunction(()=>!!document.querySelector("dialog")||!!document.querySelector('input[type=password]'));
    expect(await signout(page).count(),"live and draining dictation is listed in the deletion warning").toBe(1);
    await signout(page).waitFor();
    expect(await signout(page).innerText(), "live and draining dictation is listed in the deletion warning").toContain("Unaccepted dictation text");
    await click(page,"Keep working");
    const voice=await work(page,w=>w.background());
    expect(voice.finalText || voice.partial,"Keep working preserves unaccepted live text").not.toBe("");
  } finally {await context.close();}
},30_000);

runtimeTest("Escape cancels only the local-work dialog while Settings and Dictation stay open",async()=>{
  const {page,context}=await boot(1280);
  try { await signIn(page);await work(page,w=>{w.live("final");w.compose();});
    await page.getByRole("heading",{name:"Settings",exact:true}).waitFor();
    await click(page,"Sign out everywhere");await signout(page).waitFor();
    await page.keyboard.press("Escape");await signout(page).waitFor({state:"detached"});
    expect(await work(page,w=>w.background()),"Escape never reaches the underlying Settings or Dictation handlers").toEqual({settingsClosed:0,dictationCancelled:0,finalText:"Odysseus approaches Ithaca.",partial:""});
    expect(await page.getByRole("button",{name:"Sign out everywhere",exact:true}).isVisible(),"Settings remains usable after cancellation").toBe(true);
  } finally {await context.close();}
},30_000);

runtimeTest("sign-out waits for an in-flight transcript write then clears its account completely",async()=>{
  const {page,context}=await boot();
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;
    await page.evaluate(key=>window.__work.seed(`account:${key}`,"sirens"),key);
    await click(page,"Sign out everywhere");await signout(page).waitFor();
    await work(page,w=>w.pendingTranscript());
    await click(page,"Sign out and delete");
    await page.waitForTimeout(100);
    expect(await signout(page).count(),"the consent stays mounted while a pending native write blocks its refreshed inventory").toBe(1);
    expect(await page.evaluate(async () => (await fetch("/api/vpn-check")).status),"logout waits while the existing native transaction owns the recording lock").toBe(200);
    await work(page,w=>w.release());
    await page.waitForFunction(()=>document.body.textContent?.includes("Local work changed.")||!!document.querySelector('input[type=password]'));
    expect(await signout(page).count(),"the pending transcript requires a refreshed warning before deletion").toBe(1);
    expect(await signout(page).innerText(),"the refreshed warning includes the committed pending transcript").toContain("1 with an unaccepted transcript");
    const navigation=page.waitForNavigation();await click(page,"Sign out and delete");await navigation;
    await page.locator('input[type=password]').waitFor();await assertEmpty(page,key);
    expect(await page.locator("body").innerText(),"a healthy pending write causes no false deletion failure").not.toContain("could not be completely cleared");
  } finally {await context.close();}
},30_000);

runtimeTest("another tab cannot resurrect deleted drafts or write through a stale account handle",async()=>{
  const {page,context}=await boot();let other:Page|undefined;
  try {await signIn(page);await work(page,w=>w.edit());await work(page,w=>w.seed("unassigned","aeolus"));const key=(await work(page,w=>w.key()))!;
    other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());await work(other,w=>w.ready());
    await work(other,async w=>{await w.holdWriter();w.dirty();});
    const snapshotsBefore=await work(other,w=>w.snapshots());
    await click(page,"Sign out everywhere");await signout(page).waitFor();
    const navigation=page.waitForNavigation();await click(page,"Sign out and delete");await navigation;await page.locator('input[type=password]').waitFor();
    await other.locator('input[type=password]').waitFor();
    expect(await work(other,w=>w.snapshots()),"intentional sign-out in another tab omits the auth-expiry snapshot").toBe(snapshotsBefore);
    await assertEmpty(page,key);
    expect(await work(other,w=>w.staleWrite()),"a previously held account handle is fenced after confirmed deletion").toBe("PartitionRefusedError");
    expect(await work(other,w=>w.staleNative()),"the native transaction fence refuses a writer even with a stale storage marker").not.toBe("ok");
    const retained=await work(page,w=>w.read("unassigned"));
    expect(await work(other,w=>w.staleNativeMove()),"a move also validates the destination native writer fence").not.toBe("ok");
    expect(await work(page,w=>w.read("unassigned")),"a fenced destination cannot consume the retained unassigned source").toEqual(retained);
    await work(other,w=>w.snapshot());await assertEmpty(page,key);
    await signIn(page);await associationShown(page);await click(page,"Not now");await work(page,w=>w.edit());
    expect(await work(other,w=>w.staleWrite()),"an explicit new sign-in cannot revive the previous writer generation").toBe("PartitionRefusedError");
    expect((await page.evaluate(key=>window.__work.read(`account:${key}`),key)).some(r=>r.key==="stale:penelope")).toBe(false);
  } finally {await context.close();}
},30_000);

runtimeTest("failed logout reports its notice even when the next boot remains authenticated",async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,w=>w.edit());await click(page,"Sign out everywhere");await signout(page).waitFor();
    await page.route("**/api/auth/logout",route=>route.fulfill({status:503,json:{error:"Scripted logout failure"}}));
    const navigation=page.waitForNavigation();await click(page,"Sign out and delete");await navigation;await page.waitForFunction(()=>!!window.__work?.key());
    expect(await page.locator("body").innerText(),"authenticated boot still reports failed logout").toContain("could not be completely cleared");
    expect(await page.evaluate(async () => (await fetch("/api/vpn-check")).status),"fixture actually retains the real session cookie").toBe(200);
    await page.unroute("**/api/auth/logout");const retry=page.waitForNavigation();await click(page,"Sign out everywhere");await page.waitForFunction(()=>!!document.querySelector("dialog")||!!document.querySelector('input[type=password]'));
    expect(await signout(page).count(),"an already-cleared account needs no extra deletion warning on retry").toBe(0);await retry;await page.locator('input[type=password]').waitFor();
    expect(await page.locator("body").innerText(),"retrying an already-cleared account reports no false storage failure").not.toContain("could not be completely cleared");
    expect(await page.evaluate(async () => (await fetch("/api/vpn-check")).status)).toBe(401);
  } finally {await context.close();}
},30_000);

runtimeTest("an unrelated recording lock cannot delay scoped account sign-out",async()=>{
  const {page,context}=await boot();let other:Page|undefined;
  try {await signIn(page);await work(page,w=>w.edit());const key=(await work(page,w=>w.key()))!;
    other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());
    await work(other,w=>w.holdRecordingLock());
    await click(page,"Sign out everywhere");await signout(page).waitFor();
    const navigation=page.waitForNavigation({timeout:10_000});await click(page,"Sign out and delete");
    await page.locator('input[type=password]').waitFor({timeout:2000}).catch(()=>{});
    expect(await page.locator('input[type=password]').count(),"sign-out completes while an unrelated recording lock stays held").toBe(1);
    await navigation;
    expect(await work(other,w=>w.lockHeld()),"the unrelated native recording lock stays held while sign-out finishes").toBe(true);
    await assertEmpty(page,key);await work(other,w=>w.releaseRecordingLock());
  }finally{await context.close();}
},30_000);

runtimeTest("optional unassigned deletion stops a cold tab's capture and admits a new explicit capture",async()=>{
  const {page,context}=await boot();let other:Page|undefined;
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;
    other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());await work(other,w=>w.captureUnassigned());
    expect((await work(other,w=>w.captureActive()))?.partition,"the second tab really records to unassigned").toBe("unassigned");
    await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();
    const navigation=page.waitForNavigation({timeout:10_000});await click(page,"Sign out and delete");await navigation;await page.locator('input[type=password]').waitFor();
    await other.waitForFunction(()=>window.__work.captureActive()===null, undefined, {timeout:1500}).catch(()=>{});
    expect(await work(other,w=>w.captureActive()),"optional deletion stops the cold unassigned capture").toBe(null);
    expect(await work(page,w=>w.read("unassigned")),"a stopped cold writer cannot recreate any deleted unassigned audio").toEqual([]);
    await assertEmpty(page,key);
    await work(page,w=>w.captureUnassigned());await page.waitForTimeout(1100);await work(page,w=>w.stopCapture());
    expect((await work(page,w=>w.read("unassigned"))).filter(r=>r.key.startsWith("recording:index:")).length,"a new explicit cold capture reopens only its unassigned writer generation").toBe(1);
  }finally{await context.close();}
},30_000);

runtimeTest("another tab's uncommitted draft requires a warning before any destructive sign-out",async()=>{
  const {page,context}=await boot();let other:Page|undefined;
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;
    other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());await work(other,w=>w.ready());await work(other,w=>w.snapshot());
    await other.waitForFunction(async()=>{const key=window.__work.key()!;return (await navigator.locks.query()).held!.filter(lock=>lock.name?.startsWith(`brain-ui:account-presence:${encodeURIComponent(key)}:`)).length===2;});
    const time=new Date("2026-07-12T12:00:00Z");await other.clock.install({time});await other.clock.pauseAt(new Date(time.getTime()+10));
    await work(other,w=>w.dirty());
    expect(await work(other,w=>w.pending()),"the other draft is still waiting for its debounce").toBe(true);
    expect(await work(other,w=>w.draftTexts()),"the other tab really holds unsaved draft text").toContain("Aeolus closes the bag.");
    expect((await page.evaluate(key=>window.__work.read(`account:${key}`),key)).filter(r=>r.key.includes("/draft/")),"the pending draft has not reached IndexedDB").toEqual([]);
    await click(page,"Sign out everywhere");
    await page.waitForFunction(()=>!!document.querySelector("dialog")||!!document.querySelector('input[type=password]'));
    expect(await signout(page).count(),"uncommitted work in another tab requires a deletion warning").toBe(1);
    expect(await signout(page).innerText(),"the warning acknowledges unknown work in other account tabs").toContain("Local work in other tabs for this account is included above.");
    expect(await signout(page).innerText(),"the uncommitted peer draft is counted exactly once").toContain("1 unsent drafts");
    await click(page,"Keep working");expect(await work(other,w=>w.draftTexts()),"Keep working retains the other tab's pending draft").toContain("Aeolus closes the bag.");
    await click(page,"Sign out everywhere");await signout(page).waitFor();const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await page.locator('input[type=password]').waitFor();
    await assertEmpty(page,key);
  }finally{await context.close();}
},30_000);

runtimeTest("a background auth probe cannot cancel explicit sign-in completion or writer admission",async()=>{
  const {page,context}=await boot();let release=()=>{};
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;await work(page,async w=>{await w.seed("unassigned","sirens");await w.seed("unassigned","aeolus");});
    await click(page,"Sign out everywhere");await signout(page).waitFor();let nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await page.locator('input[type=password]').waitFor();
    let started!:()=>void;const verification=new Promise<void>(r=>{started=r;});const held=new Promise<void>(r=>{release=r;});let first=true;
    await page.route("**/api/vpn-check",async route=>{if(first){first=false;started();await held;}await route.continue();});
    await page.locator('input[type=password]').fill(PASSWORD);nav=page.waitForNavigation();await click(page,"Sign in");await verification;
    await work(page,w=>w.probe());await page.waitForFunction(()=>window.__work.vpn()==="connected");
    expect(await page.locator('input[type=password]').count(),"a background probe keeps the explicit sign-in form alive until completion").toBe(1);
    release();await nav;await associationShown(page);
    expect(await association(page).getByRole("checkbox").count(),"completed explicit sign-in still offers both retained recordings").toBe(2);
    await click(page,"Not now");await work(page,w=>w.edit());
    expect((await page.evaluate(key=>window.__work.read(`account:${key}`),key)).some(r=>r.key.includes("/draft/")),"explicit sign-in admits the writer after the probe race").toBe(true);
  }finally{release();await context.close();}
},30_000);

runtimeTest("cold sign-in confirmation failure reloads and verifies the account before admission and association",async()=>{
  const {page,context}=await boot();
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;
    await work(page,async w=>{await w.seed("unassigned","sirens");await w.seed("unassigned","aeolus");});
    await click(page,"Sign out everywhere");await signout(page).waitFor();let nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await page.locator('input[type=password]').waitFor();
    let first=true;await page.route("**/api/vpn-check",route=>{if(first){first=false;return route.abort("failed");}return route.continue();});
    await page.locator('input[type=password]').fill(PASSWORD);const fallbackNavigation=page.waitForNavigation({timeout:5000}).then(()=>true,()=>false);await click(page,"Sign in");
    expect(await fallbackNavigation,"cold confirmation failure uses the approved reload").toBe(true);await associationShown(page);
    expect(await association(page).getByRole("checkbox").count(),"cold fallback retains the explicit offer until authenticated boot").toBe(2);
    expect(await association(page).getByRole("checkbox").evaluateAll(els=>els.some(el=>el.getAttribute("aria-checked")==="true")),"cold fallback still selects no recordings").toBe(false);
    await click(page,"Not now");await work(page,w=>w.edit()).catch(()=>{});
    expect((await page.evaluate(key=>window.__work.read(`account:${key}`),key)).some(r=>r.key.includes("/draft/")),"authenticated cold fallback admits the new writer generation").toBe(true);
  }finally{await context.close();}
},30_000);

runtimeTest("two idle account tabs still sign out without an unnecessary warning",async()=>{
  const {page,context}=await boot();let other:Page|undefined;
  try {await signIn(page);other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());await work(other,w=>w.ready());
    await other.waitForFunction(async()=>{const key=window.__work.key()!;return (await navigator.locks.query()).held!.filter(lock=>lock.name?.startsWith(`brain-ui:account-presence:${encodeURIComponent(key)}:`)).length===2;});
    const nav=page.waitForNavigation();await click(page,"Sign out everywhere");await page.waitForFunction(()=>!!document.querySelector("dialog")||!!document.querySelector('input[type=password]'));
    expect(await signout(page).count(),"responsive idle tabs do not create a pending-work warning").toBe(0);await nav;
  }finally{await context.close();}
},30_000);

runtimeTest("expanded unassigned loss requires a refreshed unticked warning before deletion",async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,w=>w.seed("unassigned","sirens"));
    await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());await work(other,w=>w.seed("unassigned","aeolus"));
    await click(page,"Sign out and delete");await page.waitForTimeout(300);
    expect(await signout(page).count(),"expanded unassigned loss requires renewed destructive consent").toBe(1);
    expect(await signout(page).innerText()).toContain("Local work changed.");
    expect(await signout(page).getByRole("checkbox").getAttribute("aria-checked"),"expanded unassigned deletion returns to unticked").toBe("false");
    expect(await signout(page).innerText()).toContain("Also delete 2 recordings");
    expect((await work(page,w=>w.rows("unassigned"))).length,"refreshing consent deletes no recording").toBe(2);
    expect(await page.evaluate(async()=>(await fetch("/api/vpn-check")).status),"refreshing consent does not perform logout").toBe(200);
    await signout(page).getByRole("checkbox").check();const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;
    expect(await work(page,w=>w.read("unassigned")),"renewed explicit consent deletes the displayed unassigned inventory").toEqual([]);
  }finally{await context.close();}
},30_000);

runtimeTest("expanded account loss requires refreshed counts before deletion",async()=>{
  const {page,context}=await boot();
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;await work(page,w=>w.edit());
    await click(page,"Sign out everywhere");await signout(page).waitFor();
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());await work(other,w=>w.seed(`account:${w.key()!}`,"aeolus"));
    await click(page,"Sign out and delete");await page.waitForTimeout(300);
    expect(await signout(page).count(),"expanded account loss requires renewed destructive consent").toBe(1);
    expect(await signout(page).innerText(),"refreshed account warning includes the new recording").toContain("1 recordings not yet added to a draft");
    expect((await page.evaluate(key=>window.__work.read(`account:${key}`),key)).some(r=>r.key.startsWith("recording:index:")),"refreshing account consent preserves the new recording").toBe(true);
    const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await assertEmpty(page,key);
  }finally{await context.close();}
},30_000);

runtimeTest("a paused administrative clear cannot delete a newer unassigned capture generation",async()=>{
  const {page,context}=await boot();
  try {await work(page,w=>w.seed("unassigned","sirens"));await work(page,w=>w.prepareUnassignedClear());
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work);await work(other,w=>w.captureUnassigned());await page.waitForTimeout(1100);await work(other,w=>w.stopCapture());
    const kept=await work(other,w=>w.read("unassigned"));expect(kept.filter(r=>r.key.startsWith("recording:index:")).length,"a newer generation really committed its capture").toBe(2);
    expect(await work(page,w=>w.staleUnassignedClear()),"native administrative authority refuses an older clear").toBe("PartitionRefusedError");
    expect(await work(other,w=>w.read("unassigned")),"a paused older clear preserves every byte of the newer capture").toEqual(kept);
  }finally{await context.close();}
},30_000);

runtimeTest("a paused administrative admission cannot reopen a newer native sign-out fence",async()=>{
  const {page,context}=await boot();
  try {await work(page,w=>w.clearUnassigned());await work(page,w=>w.stageAdmission());
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work);await work(other,w=>w.clearUnassigned());
    expect(await work(other,w=>w.unassignedClosed()),"the newer administrative clear committed its native fence").toBe(true);
    expect(await work(page,w=>w.finishStaleAdmission()),"native administrative authority refuses an older admission").toBe("PartitionRefusedError");
    expect(await work(other,w=>w.unassignedClosed()),"an older admission leaves the newer native fence closed").toBe(true);
    expect(await work(other,w=>w.read("unassigned"))).toEqual([]);
  }finally{await context.close();}
},30_000);

for (const action of ["associate", "discard", "transcript"] as const) runtimeTest(`explicit ${action} recovers survivors of a failed unassigned clear without reviving old writers`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;
    await work(page,async w=>{await w.seed("unassigned","sirens");await w.seed("unassigned","aeolus");});
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());await work(other,w=>w.holdUnassignedWriter());
    await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();await work(page,w=>w.failUnassignedClear());
    const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await page.locator('input[type=password]').waitFor();await assertEmpty(page,key);
    expect((await work(page,w=>w.read("unassigned"))).filter(r=>r.key.startsWith("recording:index:")).length,"native failed clear retains both recovery candidates").toBe(2);
    expect(await page.locator("body").innerText()).toContain("could not be completely cleared");
    await signIn(page);await associationShown(page);await click(page,"Not now");
    expect(await page.evaluate(action=>window.__work.recoveryAction(action,"sirens"),action),`explicit ${action} of a failed-clear survivor succeeds`).toBe("ok");
    expect(await work(other,w=>w.staleUnassignedWrite()),"recovery never readmits the old independent writer").toBe("PartitionRefusedError");
    const kept=await work(page,w=>w.read("unassigned"));expect(kept.some(r=>r.key==="recording:index:aeolus"),"recovery keeps the untouched sibling").toBe(true);
    if(action==="associate") expect((await page.evaluate(key=>window.__work.read(`account:${key}`),key)).some(r=>r.key==="recording:index:sirens")).toBe(true);
    else if(action==="discard") expect(kept.some(r=>r.key==="recording:index:sirens")).toBe(false);
    else expect((kept.find(r=>r.key==="recording:index:sirens")!.value as {transcript:string}).transcript).toBe("Aeolus keeps the bag sealed.");
  }finally{await context.close();}
},30_000);

for (const delayStorage of [false,true]) runtimeTest(`recovering unassigned survivors never readmits an earlier transcript request in the same store (${delayStorage ? "delayed" : "ordinary"} storage events)`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,async w=>{await w.seed("unassigned","sirens");await w.seed("unassigned","aeolus");});
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work);await other.evaluate(delay=>window.__work.mountColdReader(delay),delayStorage);await other.locator("[data-cold-reader]").getByText(/^On this device ·/).waitFor();await work(other,w=>w.stageColdTranscript());
    await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();await work(page,w=>w.failUnassignedClear());
    const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await page.locator('input[type=password]').waitFor();
    // Admission happens before lock acquisition: this explicit recovery opens
    // the new writer generation, then the still-held old request owns the lock.
    expect(await work(other,w=>w.coldRecovery())).toBe("Error");
    expect(await work(other,w=>w.releaseColdTranscript()),"recovery refuses the earlier transcript continuation in the same store").toBe("PartitionRefusedError");
    const row=(await work(page,w=>w.read("unassigned"))).find(r=>r.key==="recording:index:sirens")!;
    expect(row,"the failed clear left a real survivor to protect").toBeDefined();
    expect((row.value as {transcript?:string}).transcript,"an earlier transcript request never writes after renewed admission").not.toBe("This old transcript must never commit.");
  }finally{await context.close();}
},30_000);

runtimeTest("a queued unassigned close invalidates old playback even after recovery reopens its writer",async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,async w=>{await w.seed("unassigned","sirens");await w.seed("unassigned","aeolus");});
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work);await work(other,w=>w.mountColdReader(true));await other.locator("[data-cold-reader]").getByText(/^On this device ·/).waitFor();await work(other,w=>w.coldPlayback());
    await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();await work(page,w=>w.failUnassignedClear());const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await page.locator('input[type=password]').waitFor();
    expect(await work(other,w=>w.coldRecovery()),"the surviving peer opens a real new writer generation").toBe("ok");
    expect(await work(other,w=>w.coldPlayable()),"the frozen peer still holds an older real blob before receiving its queued event").toBe(true);
    await work(other,w=>w.flushColdStorage());
    expect(await work(other,w=>w.coldPlayable()),"the queued close invalidates older playback even after reopening").toBe(false);
  }finally{await context.close();}
},30_000);

for (const action of ["capture","transcript","playback"] as const) runtimeTest(`a queued older close preserves a newly admitted ${action}`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,async w=>{await w.seed("unassigned","sirens");await w.seed("unassigned","aeolus");});
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work);await work(other,w=>w.mountColdReader(true));await other.locator("[data-cold-reader]").getByText(/^On this device ·/).waitFor();
    await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();await work(page,w=>w.failUnassignedClear());const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await page.locator('input[type=password]').waitFor();
    expect(await work(other,w=>w.coldRecovery()),"an explicit survivor recovery really admits the new generation").toBe("ok");
    if(action==="capture") await work(other,w=>w.coldStart());else if(action==="transcript") await work(other,w=>w.stageColdTranscript());else { await work(other,w=>w.coldPlayback());expect(await work(other,w=>w.coldPlayable()),"fresh playback really owns a playable blob before the queued close").toBe(true); }
    await work(other,w=>w.flushColdStorage());await other.waitForTimeout(300);
    if(action==="capture") {
      expect(await work(other,w=>w.coldActive()),"an older queued close never stops a newly admitted capture").not.toBeNull();await work(other,w=>w.coldStop());
    }else if(action==="transcript") expect(await work(other,w=>w.releaseColdTranscript()),"an older queued close never refuses a newly admitted transcript").toBe("ok");
    else expect(await work(other,w=>w.coldPlayable()),"an older queued close never revokes newly admitted playback").toBe(true);
  }finally{await context.close();}
},30_000);

for (const surface of ["cached-offline","forbidden"] as const) for (const failedClear of [false,true]) runtimeTest(`sign-out ${failedClear?"failure":"retention"} notice survives a ${surface} boot`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,w=>w.seed("unassigned","sirens"));
    if(surface==="cached-offline") await work(page,w=>w.cacheShell());
    await page.route("**/api/auth/logout",async route=>{
      const response=await route.fetch();
      if(surface==="cached-offline") await context.setOffline(true);else await page.route("**/api/vpn-check",r=>r.fulfill({status:403,contentType:"application/json",body:'{"error":"VPN required"}'}));
      await route.fulfill({response});
    });
    await click(page,"Sign out everywhere");await signout(page).waitFor();if(failedClear) await work(page,w=>w.clearFailure());const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;
    if(surface==="cached-offline") await page.locator("[data-local-capture-screen]").waitFor();else await page.getByRole("heading",{name:"VPN Required"}).waitFor();
    if(failedClear) expect(await page.locator("body").innerText(),`${surface} boot reports the failed sign-out attempt`).toContain("could not be completely cleared");
    expect(await page.locator("body").innerText(),`${surface} boot shows the retained unassigned recording count`).toContain("1 recordings not linked to any account are still on this device.");
  }finally{await context.close();}
},30_000);

runtimeTest("unassigned clearing revokes idle peer playback, cancels its pending result and refreshes its tray",async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,w=>w.seed("unassigned","sirens"));
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work);await work(other,w=>w.mountColdReader());
    const cold=other.locator("[data-cold-reader]");await cold.getByText(/^On this device ·/).waitFor();
    expect(await work(other,w=>w.coldKey()),"the independent reader has no account key").toBeNull();await work(other,w=>w.coldPlayback());
    expect(await work(other,w=>w.coldPlayable()),"the idle peer owns a playable nonempty blob URL before clearing").toBe(true);await work(other,w=>w.stageColdPlayback());
    const refreshBefore=await work(other,w=>w.coldRefreshes());await work(page,w=>w.stageUnassignedClear());
    await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();const nav=page.waitForNavigation();await click(page,"Sign out and delete");await page.waitForFunction(()=>window.__work.clearWaiting());
    await other.waitForFunction(before=>window.__work.coldRefreshes()>before,refreshBefore);
    expect(await cold.getByText(/^On this device ·/).count(),"the preparation refresh finishes while real unassigned rows still exist").toBe(1);
    await work(page,w=>w.releaseUnassignedClear());await nav;await page.locator('input[type=password]').waitFor();
    await other.waitForFunction(async()=>!await window.__work.coldPlayable(),{},{timeout:1500}).catch(()=>{});
    expect(await work(other,w=>w.coldPlayable()),"unassigned clearing revokes the idle peer's existing blob URL").toBe(false);
    expect(await work(other,w=>w.releaseColdPlayback()),"unassigned clearing refuses a previously read pending playback result").not.toBe("ok");
    await cold.getByText(/^On this device ·/).waitFor({state:"detached",timeout:1500}).catch(()=>{});
    expect(await cold.getByText(/^On this device ·/).count(),"committed unassigned clearing refreshes the mounted idle peer tray").toBe(0);
    expect(await work(page,w=>w.read("unassigned"))).toEqual([]);
  }finally{await context.close();}
},30_000);

for (const phase of ["initial","refreshed"] as const) for (const kind of ["recording","transcript","unassigned"] as const) runtimeTest(`${phase} inventory includes durable ${kind} committed during peer discovery`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;
    if(kind==="transcript" || phase==="refreshed") await page.evaluate(({key,kind})=>window.__work.seed(kind==="unassigned"?"unassigned":`account:${key}`,"sirens"),{key,kind});
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work?.key());await work(other,w=>w.ready());
    if(phase==="refreshed") {await click(page,"Sign out everywhere");await signout(page).waitFor();if(kind==="unassigned") await signout(page).getByRole("checkbox").check();}
    await work(page,w=>w.holdPeerQuery());await click(page,phase==="initial"?"Sign out everywhere":"Sign out and delete");await page.waitForFunction(()=>window.__work.peerQueryWaiting());
    const partition=kind==="unassigned"?"unassigned":`account:${key}`;
    await other.evaluate(({partition,kind})=>window.__work.seed(partition,kind==="transcript"?"sirens":"aeolus",kind==="transcript"),{partition,kind});
    expect((await other.evaluate(partition=>window.__work.read(partition),partition)).some(r=>r.key===`recording:index:${kind==="transcript"?"sirens":"aeolus"}`),"the peer really committed its late recording metadata").toBe(true);
    await work(page,w=>w.releasePeerQuery());await page.waitForTimeout(500);
    expect(await signout(page).count(),`${phase} inventory includes durable ${kind} before destructive consent`).toBe(1);
    const shown=await signout(page).innerText();
    expect(shown,`${phase} warning counts the durable ${kind} committed during peer discovery`).toContain(kind==="transcript"?"1 with an unaccepted transcript":kind==="unassigned"?`Also delete ${phase==="initial"?1:2} recordings`:`${phase==="initial"?1:2} recordings not yet added to a draft`);
    if(phase==="refreshed") expect(shown).toContain("Local work changed.");
    expect(await page.evaluate(async()=>(await fetch("/api/vpn-check")).status)).toBe(200);await click(page,"Keep working");
  }finally{await context.close();}
},30_000);

for (const offer of ["automatic","tray"] as const) runtimeTest(`${offer} association belongs to its requesting root and never carries selection into a replacement`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,async w=>{await w.seed("unassigned","sirens");await w.seed("unassigned","aeolus");});
    await click(page,"Sign out everywhere");await signout(page).waitFor();const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await page.locator('input[type=password]').waitFor();await signIn(page);await associationShown(page);
    if(offer==="tray") {await click(page,"Not now");await act(page,page.getByRole("button",{name:/On this device/}));await act(page,page.getByRole("button",{name:"Add to my account…",exact:true}).first());await associationShown(page);}
    await association(page).getByRole("checkbox").first().check();expect(await association(page).getByRole("checkbox").first().getAttribute("aria-checked"),"the original sheet has a real selected recording").toBe("true");
    await work(page,w=>w.replaceRoot());await page.waitForFunction(()=>window.__work.replacementReady());await settled(page);
    expect(await work(page,w=>w.replacementHasSignIn()),"the replacement connects by a real background probe without an explicit sign-in marker").toBe(false);
    expect(await association(page).count(),`${offer} association never opens on a replacement root without its own explicit request`).toBe(0);
    const trayHeader=page.getByRole("button",{name:/On this device/});
    if(await trayHeader.getAttribute("aria-expanded")!=="true") await act(page,trayHeader);
    await act(page,page.getByRole("button",{name:"Add to my account…",exact:true}).first());await associationShown(page);
    expect(await association(page).getByRole("checkbox").evaluateAll(els=>els.some(el=>el.getAttribute("aria-checked")==="true")),"an explicit replacement-root offer carries no old selection").toBe(false);await click(page,"Not now");
  }finally{await context.close();}
},30_000);

runtimeTest("committed deletion invalidates peer playback opened during its closed generation",async()=>{
  const {page,context}=await boot();
  try {await signIn(page);await work(page,w=>w.seed("unassigned","sirens"));
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>!!window.__work);await work(other,w=>w.mountColdReader());await other.locator("[data-cold-reader]").getByText(/^On this device ·/).waitFor();
    await work(page,w=>w.stageUnassignedClear());await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();const nav=page.waitForNavigation();await click(page,"Sign out and delete");await page.waitForFunction(()=>window.__work.clearWaiting());
    await work(other,w=>w.coldPlayback());expect(await work(other,w=>w.coldPlayable()),"the closing generation has a real readable survivor before deletion commits").toBe(true);await work(other,w=>w.stageColdPlayback());
    await work(page,w=>w.releaseUnassignedClear());await nav;await page.locator('input[type=password]').waitFor();await other.waitForTimeout(300);
    expect(await work(other,w=>w.coldPlayable()),"committed deletion revokes playback opened during the closed generation").toBe(false);
    expect(await work(other,w=>w.releaseColdPlayback()),"committed deletion refuses pending playback from the closed generation").not.toBe("ok");
    expect(await work(page,w=>w.read("unassigned"))).toEqual([]);
  }finally{await context.close();}
},30_000);

for (const phase of ["initial", "refreshed"] as const) for (const kind of ["dictation", "draft", "track"] as const) runtimeTest(`${phase} loss inventory includes late ${kind} work before destructive consent`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);
    if(phase==="refreshed") {await work(page,w=>w.seed(`account:${w.key()!}`,"sirens"));await click(page,"Sign out everywhere");await signout(page).waitFor();}
    await work(page,w=>w.pendingInventory());await click(page,phase==="initial"?"Sign out everywhere":"Sign out and delete");
    if(kind==="dictation") await work(page,w=>w.live("partial"));else if(kind==="draft") await work(page,w=>w.dirty());else await work(page,w=>w.stage());
    await work(page,w=>w.release());await work(page,w=>w.pendingDone());await page.waitForTimeout(500);
    expect(await signout(page).count(),`${phase} inventory warns about late ${kind} before deletion or logout`).toBe(1);
    const shown=await signout(page).innerText();expect(shown).toContain(kind==="dictation"?"Unaccepted dictation text":kind==="draft"?"1 unsent drafts":"1 staged track references");
    if(phase==="refreshed") expect(shown).toContain("Local work changed.");
    expect(await page.evaluate(async()=>(await fetch("/api/vpn-check")).status),"late local work requires a new confirmation before logout").toBe(200);
    await click(page,"Keep working");
  }finally{await context.close();}
},30_000);

for (const action of ["Keep working", "Escape", "uncheck"] as const) runtimeTest(`pending destructive consent is invalidated by ${action}`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);const key=(await work(page,w=>w.key()))!;
    await page.evaluate(key=>window.__work.seed(`account:${key}`,"sirens",true),key);await work(page,w=>w.seed("unassigned","aeolus"));
    const accountBefore=await page.evaluate(key=>window.__work.read(`account:${key}`),key);const unassignedBefore=await work(page,w=>w.read("unassigned"));
    expect(accountBefore.filter(r=>r.key.startsWith("recording:chunk:")).length,"cancelled consent has nonempty account audio to protect").toBe(1);
    await click(page,"Sign out everywhere");await signout(page).waitFor();await signout(page).getByRole("checkbox").check();
    await work(page,w=>w.pendingTranscript());await click(page,"Sign out and delete");
    if(action==="Escape") await page.keyboard.press("Escape");else if(action==="uncheck") await signout(page).getByRole("checkbox").uncheck();else await click(page,"Keep working");
    await work(page,w=>w.release());await work(page,w=>w.pendingDone());await page.waitForTimeout(600);
    expect(await page.evaluate(async()=>(await fetch("/api/vpn-check")).status),`${action} invalidates pending consent before logout`).toBe(200);
    const accountAfter=await page.evaluate(key=>window.__work.read(`account:${key}`),key);
    expect(accountAfter.filter(r=>r.key.startsWith("recording:chunk:")),`${action} preserves account audio after cancelling pending consent`).toEqual(accountBefore.filter(r=>r.key.startsWith("recording:chunk:")));
    expect(await work(page,w=>w.read("unassigned")),`${action} never deletes unassigned audio through stale consent`).toEqual(unassignedBefore);
    if(action==="uncheck") {
      expect(await signout(page).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
      const nav=page.waitForNavigation();await click(page,"Sign out and delete");await nav;await assertEmpty(page,key);
      expect(await work(page,w=>w.read("unassigned")),"a new confirmation honors the current unticked option").toEqual(unassignedBefore);
    }else expect(await signout(page).count()).toBe(0);
  }finally{await context.close();}
},30_000);

for (const generation of ["initial", "reopened"] as const) runtimeTest(`a full origin permits explicit unassigned discard in its ${generation} admitted generation`,async()=>{
  const {page,context}=await boot();
  try {await signIn(page);if(generation==="reopened") await work(page,w=>w.reopenUnassigned());await work(page,w=>w.seed("unassigned","sirens"));
    expect(await work(page,w=>w.fullDiscard("sirens")),`full-origin discard uses the existing ${generation} admission without allocating a fence`).toBe("ok");
    expect(await work(page,w=>w.read("unassigned")),"full-origin discard deletes all of the recording metadata and audio").toEqual([]);
  }finally{await context.close();}
},30_000);
