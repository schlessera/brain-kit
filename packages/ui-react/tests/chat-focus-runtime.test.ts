import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { askUserFormSpec } from "@schlessera/brain-ui-sdk/internal/client";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// The same real-Chrome prerequisite enforced by the unit CI jobs. Focus is
// measured on the actual public ChatPage, never on a substitute textarea.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Chat focus runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING chat focus runtime proof: no Chrome; composer handoff is unverified locally.");

const repo = resolve(import.meta.dir, "../../.."), content = "Odysseus packed timber and rope for the raft.";
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let origin = "", brain = "";
let sequence = 0;
const replies = new Map<string, unknown>();

beforeAll(async () => {
  if (!executablePath) return;
  // Browser imports use the published default exports. Rebuild from source
  // on every run so a marker mutation cannot be hidden by stale dist output.
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Focus fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-chat-focus-"));
  brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  // Use a fresh resolver after the package build replaces dist directories.
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/chat-focus-client.ts"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Public chat client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html class="dark" data-theme="dark"><head><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  const backend: AgentBackend = {
    id: "focus-scripted", capabilities: { resume: false, permissions: true, thinking: false, attachments: false, askUser: true, costReporting: false, concurrentSessions: false, followUp: false },
    listProfiles: () => [{ id: "focus-scripted", label: "Local fixture" }], listSessions: async () => [], getHistory: async () => [],
    async startTurn({ prompt, bridge }) {
      const sessionId = `odysseus-focus-${++sequence}`;
      bridge.emit({ type: "session_info", sessionId, isNew: true });
      if (prompt === "list") {
        replies.set(prompt, await bridge.askUserList!(`list-${sequence}`, { prompt: "Choose raft supplies", items: [{ id: "rope", label: "Rope" }], scale: [{ label: "Pack" }, { label: "Leave" }], allowSkip: false, notes: false }));
      } else if (prompt === "rank") {
        replies.set(prompt, await bridge.askUserRank!(`rank-${sequence}`, { prompt: "Order raft supplies", items: [{ id: "rope", label: "Rope" }, { id: "timber", label: "Timber" }] }));
      } else if (prompt === "form") {
        replies.set(prompt, await bridge.askUserForm!(`form-${sequence}`, askUserFormSpec({ prompt: "Record raft supplies", nodes: [{ id: "note", kind: "text", prompt: "Supply note", required: true }] })));
      } else {
        const count = prompt === "pending" ? 2 : 1;
        await Promise.all(Array.from({ length: count }, async (_, i) => {
          const toolUseId = `write-${sequence}-${i}`, path = `notes/raft-${sequence}-${i}.md`, input = { file_path: path, content };
          bridge.emit({ type: "tool_use_start", sessionId, toolUseId, toolName: "Write" });
          bridge.emit({ type: "tool_use_complete", sessionId, toolUseId, toolName: "Write", input });
          const decision = await bridge.requestPermission({ toolUseId, toolName: "Write", input, kind: "command", description: "Write the fictional raft note." });
          if (decision.behavior === "allow") await writeFile(resolve(brain, path), content);
          replies.set(toolUseId, { decision: decision.behavior, path });
          bridge.emit({ type: "tool_result", sessionId, toolUseId, output: `${decision.behavior}: ${path}`, isError: decision.behavior === "deny" });
        }));
      }
      bridge.emit({ type: "text_delta", sessionId, text: `Completed ${prompt}` });
      bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 0, numTurns: 1, isError: false });
    },
  };
  app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(scratch, "ui.db"), AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }), staticRoot: assets, registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(), turnTimeoutMs: 20_000 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], timeout: 120_000 });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  app?.cancelActiveTurns();
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function open(prompt: string): Promise<Page> {
  const context = await browser!.newContext();
  // Keep the real browser offline apart from this one local app.
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction("window.__focusFixture?.connected()");
  const composer = page.locator("textarea.bk-composer");
  expect(await composer.count()).toBe(1);
  await composer.fill(prompt);
  await composer.press("Enter");
  return page;
}

async function focus(page: Page) {
  return page.evaluate(() => ({ tag: document.activeElement?.tagName, composer: document.activeElement === document.querySelector("textarea.bk-composer") }));
}
async function completed(page: Page, prompt: string) {
  await page.getByText(`Completed ${prompt}`, { exact: true }).first().waitFor();
  expect((await focus(page)).composer, `active element: ${(await focus(page)).tag}`).toBe(true);
}

describe.skipIf(!executablePath)("mounted public chat decision focus", () => {
  for (const decision of ["allow", "deny"] as const) test(`${decision} of the final nonempty Write focuses the real composer after the result`, async () => {
    const page = await open("approval");
    try {
      const card = page.locator("[data-approval-card]");
      await card.waitFor();
      expect(await page.locator("body").textContent()).toContain(content);
      const turn = sequence;
      await card.getByRole("button", { name: decision === "allow" ? "Allow" : "Deny", exact: true }).click();
      await completed(page, "approval");
      expect(replies.get(`write-${turn}-0`)).toEqual({ decision, path: `notes/raft-${turn}-0.md` });
      const file = resolve(brain, `notes/raft-${turn}-0.md`);
      if (decision === "allow") expect(await readFile(file, "utf8")).toBe(content);
      else expect(existsSync(file)).toBe(false);
    } finally { await page.context().close(); }
  });

  // An answer's focus stays on its delivery status (#910, design §6), which
  // supersedes D37 §6's composer handoff for the four ask cards.
  for (const prompt of ["list", "rank", "form"] as const) test(`${prompt} submit moves focus to the answer's status, which reads Answered once the backend has it`, async () => {
    const page = await open(prompt);
    try {
      if (prompt === "list") {
        await page.getByRole("radio", { name: "Pack, Rope", exact: true }).click();
        await page.getByRole("button", { name: "Submit 1", exact: true }).click();
      } else if (prompt === "rank") {
        await page.getByRole("button", { name: "Keep this order", exact: true }).click();
      } else {
        await page.getByRole("textbox", { name: "Supply note", exact: true }).fill(content);
        await page.getByRole("button", { name: "Submit", exact: true }).click();
      }
      await page.locator('[data-answer-delivery="answered"]').waitFor();
      await page.getByText(`Completed ${prompt}`, { exact: true }).first().waitFor();
      const status = await page.evaluate(() => ({
        heading: document.activeElement?.tagName,
        text: document.activeElement?.textContent,
        inStatus: !!document.activeElement?.closest("[data-answer-delivery]"),
      }));
      expect(status).toEqual({ heading: "H4", text: "ANSWERED", inStatus: true });
      const answer = replies.get(prompt);
      expect(answer).toBeDefined();
      if (prompt === "list") expect(answer).toMatchObject({ answers: { rope: "Pack" } });
      if (prompt === "rank") expect(answer).toMatchObject({ order: ["rope", "timber"], unchanged: true });
      if (prompt === "form") expect(answer).toMatchObject({ answers: { note: content } });
    } finally { await page.context().close(); }
  });

  for (const first of [0, 1]) test(`resolving card ${first + 1} keeps the ${first === 0 ? "next" : "previous"} handoff, then the final decision focuses the composer`, async () => {
    const page = await open("pending");
    try {
      const cards = page.locator("[data-approval-card]");
      await cards.nth(1).waitFor();
      const turn = sequence;
      await cards.nth(first).getByRole("button", { name: "Allow", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll("[data-approval-card]").length === 1);
      const remaining = await page.evaluate(() => document.activeElement === document.querySelector("[data-approval-card]"));
      expect(remaining).toBe(true);
      expect((await focus(page)).composer).toBe(false);
      await cards.getByRole("button", { name: "Deny", exact: true }).click();
      await completed(page, "pending");
      expect(replies.get(`write-${turn}-${first}`)).toMatchObject({ decision: "allow" });
      expect(replies.get(`write-${turn}-${1 - first}`)).toMatchObject({ decision: "deny" });
    } finally { await page.context().close(); }
  });
});
