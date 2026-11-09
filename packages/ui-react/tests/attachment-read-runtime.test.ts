import { runtimePackageBuild } from "./fixtures/runtime-package-build";
import { runtimeHookPhases } from "./fixtures/runtime-hook-phases.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import { handleReadAttachment, type AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { ATTACHMENT_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { createFixtureApp as createApp } from "../../ui-server/tests/helpers/native-app-fixture.js";
import { ithacaPermitPdf, PERMIT_FACT } from "../../ui-server/tests/helpers/odysseus-pdf.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// One mounted-app run of an on-demand attachment read (#3155 acceptance):
// the public ChatPage in real Chrome picks an Odysseus PDF through the
// composer's Files input, the real host admits the original and binds it to
// the draft, Send names it by reference only, and a keyless scripted turn
// calls the real `read_attachment` handler through the host bridge: the
// production reader re-verifies the original and the PDF extractor returns
// page 2. The reply quotes a sentence that exists only inside the file, and
// the sent row shows the read the host recorded. The backend's id is "pi"
// because the bridge offers reads to the two first-party backends only; the
// backends' own provider-history guards prove the native tool loops.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Attachment read runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING attachment read runtime proof: no Chrome; on-demand reads are unverified in a browser locally.");

const repo = resolve(import.meta.dir, "../../..");
const PERMIT = ithacaPermitPdf();
const QUESTION = "Which berth does the Ithaca permit reserve?";
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let brain = "";
let origin = "";
let sequence = 0;

/** What the scripted turn saw and did, in order: the provider-facing view of the turn. */
type Turn = { sessionId: string; prompt: string; history: string[]; reads: Array<{ isError: boolean; text: string }>; reply: string };
const turns: Turn[] = [];

/** The sentence a reply can only know by reading: the line of the delimited contents that names a berth. */
function quoteFrom(toolText: string): string | null {
  const nonce = /<<<attachment-data-([0-9a-f-]+)\n/.exec(toolText)?.[1];
  if (!nonce) return null;
  const contents = toolText.slice(toolText.indexOf(`<<<attachment-data-${nonce}\n`) + `<<<attachment-data-${nonce}\n`.length, toolText.indexOf(`\nattachment-data-${nonce}>>>`));
  return contents.split("\n").map((line) => line.trim()).find((line) => /\bberth\b/i.test(line)) ?? null;
}

const hook = runtimeHookPhases("attachment-read-runtime.test.ts");
beforeAll(() => hook.phase("setup", async () => {
  if (!executablePath) return;
  const [out, err, code] = await runtimePackageBuild(repo, ["ui-react", "ui-server", "core"], hook);
  if (code !== 0) throw new Error(`Attachment read fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-attachment-read-"));
  brain = resolve(scratch, "brain");
  await hook.phase("fixture-files", () => createFixtureBrain(repo, brain));
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  // The drafts fixture client is the public ChatPage on a real root.
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/draft-runtime-client.ts"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await hook.child("client-build", bundle);
  if (bundleCode !== 0) throw new Error(`Attachment read client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await hook.phase("fixture-assets", async () => {
    await writeFile(resolve(assets, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
    for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
      await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
    }
  });
  const backend: AgentBackend = {
    id: "pi", capabilities: { resume: true, permissions: false, thinking: false, attachments: true, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "pi", label: "Local fixture" }],
    listSessions: async () => [],
    getHistory: async () => [],
    async startTurn({ prompt, bridge, sessionId: resumed }) {
      const sessionId = resumed ?? `odysseus-permit-${++sequence}`;
      bridge.emit({ type: "session_info", sessionId, isNew: !resumed });
      // A provider conversation is appended to, never rewritten: the host's
      // first message, then each tool call and its result at the tail.
      const turn: Turn = { sessionId, prompt, history: [prompt], reads: [], reply: "" };
      turns.push(turn);
      const ids = [...prompt.matchAll(/"id":"([a-f0-9-]{36})"/g)].map((m) => m[1]!);
      for (const id of new Set(ids)) {
        const input = { id, pages: "2" };
        turn.history.push(JSON.stringify({ tool_use: "read_attachment", input }));
        bridge.emit({ type: "tool_use_start", sessionId, toolUseId: `read-${id}`, toolName: "read_attachment" });
        bridge.emit({ type: "tool_use_complete", sessionId, toolUseId: `read-${id}`, toolName: "read_attachment", input });
        const result = await handleReadAttachment(input, bridge);
        turn.reads.push(result);
        turn.history.push(result.text);
        bridge.emit({ type: "tool_result", sessionId, toolUseId: `read-${id}`, output: result.text, isError: result.isError });
      }
      const quote = turn.reads.map((r) => (r.isError ? null : quoteFrom(r.text))).find(Boolean);
      turn.reply = quote ? `The permit says: “${quote}”` : "I could not read the permit.";
      bridge.emit({ type: "text_delta", sessionId, text: turn.reply });
      bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  app = await hook.phase("host-start", () => createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch!, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }), staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), turnTimeoutMs: 60_000 }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 }));
}), 180_000);

afterAll(() => hook.phase("cleanup", async () => {
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}));

type Wire = { type: string; text?: string; draftId?: string; draftRef?: { draftId: string; revision: number }; attachmentRefs?: Array<{ kind: string; fileId: string }> };

describe.skipIf(!executablePath)("mounted on-demand attachment read", () => {
  test("Files → upload → admitted original → Send by reference → real read_attachment → a reply only the file could give, and the recorded read on the sent row", async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
    const egress: string[] = [];
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      egress.push(route.request().url());
      return route.abort();
    });
    try {
      const page = await context.newPage();
      const sent: Wire[] = [];
      const received: Array<{ type: string; sessionId?: string; read?: { fileId: string; outcome: string; scope?: unknown } }> = [];
      const uploads: Array<{ path: string; status: number }> = [];
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => sent.push(JSON.parse(String(payload))));
        socket.on("framereceived", ({ payload }) => received.push(JSON.parse(String(payload))));
      });
      page.on("response", (res) => { if (/\/api\/drafts\/[^/]+\/files$/.test(new URL(res.url()).pathname)) uploads.push({ path: new URL(res.url()).pathname, status: res.status() }); });
      const until = (predicate: string, timeout = 15_000) =>
        page.waitForFunction(`(() => { const f = window.__drafts; return ${predicate}; })()`, undefined, { timeout });
      await page.goto(origin);
      await until("f?.connected() && f.supported() === true");

      // 1. The composer's Files input: the host admits the original.
      const files = page.locator("input[data-files-input]");
      await files.waitFor({ state: "attached" });
      await files.setInputFiles({ name: "ithaca-permit.pdf", mimeType: "application/pdf", buffer: Buffer.from(PERMIT) });
      const draftId = await page.evaluate(() => (window as unknown as { __drafts: { view(): { draftId: string } } }).__drafts.view().draftId);
      await page.locator('[data-draft-save="saved"]').waitFor({ timeout: 20_000 });
      expect(uploads).toEqual([{ path: `/api/drafts/${draftId}/files`, status: 201 }]);
      const db = app!.db;
      const row = db.query("SELECT file_id, draft_id, sha256, bytes, stored_name, kind, reader, state FROM attachment_files").get() as
        { file_id: string; draft_id: string; sha256: string; bytes: number; stored_name: string; kind: string; reader: string; state: string };
      expect(row).toMatchObject({ draft_id: draftId, bytes: PERMIT.byteLength, kind: "pdf", reader: "pdf", state: "stored", sha256: createHash("sha256").update(PERMIT).digest("hex") });
      const fileId = row.file_id;
      expect(readdirSync(join(brain, ATTACHMENT_DIR, fileId))).toEqual([row.stored_name]);
      expect(Buffer.from(await readFile(join(brain, ATTACHMENT_DIR, fileId, row.stored_name))).equals(Buffer.from(PERMIT)), "the original is stored byte-identically").toBe(true);
      // 2. The saved draft revision binds it.
      expect(db.query("SELECT owner, owner_id FROM attachment_refs WHERE file_id = ?").all(fileId)).toEqual([{ owner: "draft", owner_id: draftId }]);

      // Send: the frame names the original by reference and the revision it consumes.
      await page.locator("textarea.bk-composer").fill(QUESTION);
      await page.locator('[data-draft-save="saved"]').waitFor({ timeout: 20_000 });
      await page.locator("textarea.bk-composer").press("Enter");
      const chat = await (async () => { for (let i = 0; i < 300; i++) { const m = sent.find((f) => f.type === "chat_message"); if (m) return m; await Bun.sleep(20); } throw new Error("no chat_message was sent"); })();
      expect(chat.attachmentRefs).toEqual([{ kind: "attachment", fileId }]);
      expect(chat.draftRef?.draftId).toBe(draftId);
      expect(chat.draftRef!.revision).toBeGreaterThan(0);

      // 3–4. The turn read the original on demand; the reply depends on its contents.
      await until("f.lastAssistant() !== null && f.sends().at(-1)?.state === \"accepted\"", 30_000);
      await Promise.all([...app!.wsHost.turnTasks]);
      expect(turns).toHaveLength(1);
      const [turn] = turns;
      expect(turn!.prompt).toContain(fileId);
      expect(turn!.prompt, "the first message carries references, never the contents").not.toContain(PERMIT_FACT);
      expect(turn!.reply, "CONTENT_DEPENDENT_REPLY").toBe(`The permit says: “${PERMIT_FACT}”`);
      expect(turn!.reads.map((r) => r.isError)).toEqual([false]);
      expect(JSON.parse(turn!.reads[0]!.text.split("\n", 1)[0]!)).toMatchObject({ id: fileId, kind: "pdf", outcome: "read", scope: { pages: [2, 2], pageCount: 3 } });
      expect(await page.evaluate(() => (window as unknown as { __drafts: { lastAssistant(): string | null } }).__drafts.lastAssistant())).toBe(turn!.reply);
      // The reply is painted in the transcript, not only held in the store.
      await page.getByText(turn!.reply, { exact: true }).waitFor();
      // Provider history: the read was appended at the tail; the first message is unchanged.
      expect(turn!.history[0]).toBe(turn!.prompt);
      expect(turn!.history.at(-1)).toBe(turn!.reads[0]!.text);

      // The host recorded the read, sent it as its own frame, and the sent row shows it.
      const sessionId = turn!.sessionId;
      expect(db.query("SELECT file_id, session_id, outcome FROM attachment_reads").all()).toEqual([{ file_id: fileId, session_id: sessionId, outcome: "read" }]);
      expect(db.query("SELECT owner FROM attachment_refs WHERE file_id = ? ORDER BY owner").all(fileId)).toContainEqual({ owner: "message" });
      expect(received.filter((f) => f.type === "attachment_read").map((f) => [f.sessionId, f.read?.fileId, f.read?.outcome, f.read?.scope]))
        .toEqual([[sessionId, fileId, "read", { pages: [2, 2], pageCount: 3 }]]);
      const reads = await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}/attachment-reads`, { headers: { origin } });
      expect(reads.status).toBe(200);
      expect(((await reads.json()) as { reads: Array<{ fileId: string; outcome: string }> }).reads.map((r) => [r.fileId, r.outcome])).toEqual([[fileId, "read"]]);
      const sentRow = page.locator("[data-sent-files]");
      await sentRow.waitFor();
      let shown = "";
      for (let i = 0; i < 150 && !(shown = (await sentRow.textContent()) ?? "").includes("read p. 2"); i++) await Bun.sleep(100);
      expect(shown).toContain("ithaca-permit.pdf");
      expect(shown, "SENT_ROW_READ_STATE").toContain("read p. 2");
      expect(egress).toEqual([]);
    } finally {
      await Promise.all([...app!.wsHost.turnTasks]);
      await context.close();
    }
  }, 120_000);
});
