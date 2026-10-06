import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createApp, createRecordingObservability, createStaticBackendRegistry, resolveServerConfig } from "@schlessera/brain-ui-server";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.ts";

// Approval recovery after a reload (#964, D52 §4), on the real public
// ChatPage in real Chrome against the real app, with a scripted backend that
// keeps the user's prompt in its transcript the moment a turn starts. The
// replay after the reload therefore ends on the user's message, with no
// answer to hold the card: before #964 the pending approval was dropped.
const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = candidates.find((path) => path && statSync(path, { throwIfNoEntry: false })?.isFile());
if (!executablePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("Approval recovery runtime proof requires real Chrome");
if (!executablePath) console.warn("SKIPPING approval recovery runtime proof: no Chrome; the restored card is unverified locally.");

const repo = resolve(import.meta.dir, "../../..");
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
let origin = "";
let sequence = 0;
const transcripts = new Map<string, SessionHistoryMessage[]>();
const decisions = new Map<string, string>();

beforeAll(async () => {
  if (!executablePath) return;
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`Recovery fixture package build failed (${code}): ${out}\n${err}`);
  scratch = await mkdtemp(resolve(tmpdir(), "odysseus-approval-recovery-"));
  const brain = resolve(scratch, "brain");
  await createFixtureBrain(repo, brain);
  const assets = resolve(scratch, "client");
  await mkdir(assets);
  const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', resolve(import.meta.dir, "fixtures/approval-recovery-client.ts"), assets], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [bundleOut, bundleErr, bundleCode] = await Promise.all([new Response(bundle.stdout).text(), new Response(bundle.stderr).text(), bundle.exited]);
  if (bundleCode !== 0) throw new Error(`Recovery client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
  await writeFile(resolve(assets, "index.html"), '<!doctype html><html class="dark" data-theme="dark"><head><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>');
  for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]]) {
    await writeFile(resolve(assets, file!), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
  }
  const backend: AgentBackend = {
    id: "recovery-scripted", capabilities: { resume: true, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    listProfiles: () => [{ id: "recovery-scripted", label: "Local fixture" }],
    listSessions: async () => [...transcripts.keys()].map((id) => ({ id, title: "Past the Sirens", createdAt: 1, lastActiveAt: 2, totalCostUsd: 0, numTurns: 1 })),
    getHistory: async (sessionId) => structuredClone(transcripts.get(sessionId) ?? []),
    async startTurn({ prompt, bridge, sessionId: resumed }) {
      const sessionId = resumed ?? `odysseus-recovery-${++sequence}`;
      bridge.emit({ type: "session_info", sessionId, isNew: !resumed });
      const transcript = transcripts.get(sessionId) ?? [];
      transcripts.set(sessionId, transcript);
      transcript.push({ role: "user", content: prompt, toolCalls: [] });
      const toolUseId = `wax-${sequence}`;
      const decision = await bridge.requestPermission({ toolUseId, toolName: "Bash", input: { command: "seal --ears crew" }, kind: "command", description: "Seal the crew's ears with wax." });
      decisions.set(toolUseId, decision.behavior);
      transcript.push({ role: "assistant", content: `Completed ${prompt}`, toolCalls: [] });
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

async function connected(page: Page) {
  await page.waitForFunction("window.__recoveryFixture?.connected()");
}

/** What the transcript draws, in order: who speaks, and the cards. */
async function transcript(page: Page) {
  return page.evaluate(() => ({
    cards: document.querySelectorAll("[data-approval-card]").length,
    restored: document.querySelectorAll("[data-restored-approval]").length,
    text: document.querySelector("main")?.textContent ?? document.body.textContent ?? "",
  }));
}

describe.skipIf(!executablePath)("mounted approval recovery", () => {
  test("a reload whose replay ends on the user's message restores the pending card, marked restored and answerable", async () => {
    const context = await browser!.newContext();
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await connected(page);
      const composer = page.locator("textarea.bk-composer");
      await composer.fill("Row past the Sirens");
      await composer.press("Enter");
      await page.locator("[data-approval-card]").waitFor();
      // Raised while this page watched the turn: not restored.
      expect((await transcript(page)).restored).toBe(0);
      const sessionId = await page.evaluate(() => (window as unknown as { __recoveryFixture: { activeSessionId(): string | null } }).__recoveryFixture.activeSessionId());
      expect(sessionId).toStartWith("odysseus-recovery-");
      expect(transcripts.get(sessionId!)?.map((m) => m.role)).toEqual(["user"]);

      await page.reload();
      await connected(page);
      await page.locator("[data-restored-approval]").waitFor();
      const restored = await transcript(page);
      expect(restored).toMatchObject({ cards: 1, restored: 1 });
      expect(restored.text).toContain("Row past the Sirens");
      expect(restored.text).not.toContain("Completed");
      // Nothing was answered by the reload itself.
      expect(decisions.size).toBe(0);

      await page.locator("[data-approval-card]").getByRole("button", { name: "Allow", exact: true }).click();
      await page.getByText("Completed Row past the Sirens", { exact: true }).first().waitFor();
      expect([...decisions.values()]).toEqual(["allow"]);
      expect((await transcript(page)).cards).toBe(0);
    } finally { await context.close(); }
  });
});
