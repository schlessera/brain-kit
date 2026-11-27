import { chromePath, startRuntimeHost, type RuntimeHost } from "./fixtures/runtime-host";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { resolveServerConfig } from "@schlessera/brain-ui-server";
import { makeFakeBackend } from "../../ui-server/tests/helpers/fake-backend.js";
import type { SessionChat } from "../src/stores/chat-state.js";

// Real browser -> mounted share hook -> HTTP upload -> real host/WS echo ->
// root/store routing. A scripted keyless backend delays both announcements.
const executablePath = chromePath("share-draft-runtime.test.ts");
let host: RuntimeHost | undefined;
let app: NonNullable<RuntimeHost["app"]>;
let browser: Browser;
let origin: string;
const gates = new Map<string, () => void>();
const frames: Array<{ type: string; draftId?: string; requestId?: string; sessionId?: string }> = [];
const prompts: Array<{ sessionId: string; text: string; images: number }> = [];
let sequence = 0;
beforeAll(async () => {
  if (!executablePath) return;
  const backend = makeFakeBackend({ id: "share-scripted", capabilities: { attachments: true }, startTurn: async req => {
    const sessionId = `odysseus-share-${++sequence}`;
    prompts.push({ sessionId, text: req.prompt, images: req.attachments?.length ?? 0 });
    await new Promise<void>(resolve => gates.set(sessionId, resolve));
    req.bridge.emit({ type: "session_info", sessionId, isNew: true });
    req.bridge.emit({ type: "text_delta", sessionId, text: "Athena has the plan." });
    req.bridge.emit({ type: "result", sessionId, isError: false, durationMs: 1, numTurns: 1 });
  } });
  // Browser bundles resolve the SDK's default dist exports, not its Bun source condition.
  host = await startRuntimeHost({ file: "share-draft-runtime.test.ts", executablePath, packages: ["ui-sdk"], scratchPrefix: "odysseus-share-draft-",
    client: join(import.meta.dir, "fixtures/share-draft-client.tsx"), page: '<!doctype html><div id="app"></div><script src="/client.js"></script>',
    app: { backend, config: ({ brain, db }) => resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: db, AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }) } });
  ({ browser, origin } = host); app = host.app!;
}, 180_000);
afterAll(async () => {
  for (const release of gates.values()) release();
  await host?.close();
});

type State = { pending: string | null; active: string | null; draft: SessionChat | null; detached: Record<string, SessionChat>; buffers: Record<string, SessionChat>; queue: number; busy: boolean; error: string | null };
async function action<T>(page: Page, method: string): Promise<T> {
  return page.evaluate(method => (window as unknown as { shareDraft: Record<string, () => unknown> }).shareDraft[method]!(), method) as Promise<T>;
}
async function until(page: Page, predicate: string) {
  await page.waitForFunction(`window.shareDraft && (${predicate})`, undefined, { timeout: 8000 });
}
async function waiting(sessionId: string) {
  const end = Date.now() + 8000;
  while (!gates.has(sessionId) && Date.now() < end) await Bun.sleep(20);
  const gate = gates.get(sessionId);
  if (!gate) throw new Error(`Backend did not reach ${sessionId}`);
  return gate;
}
async function release(sessionId: string) { const gate = await waiting(sessionId); gates.delete(sessionId); gate(); }

for (const scenario of ["same draft", "new chat B", "existing conversation"] as const) test.skipIf(!executablePath)(`direct share announcement preserves ownership: ${scenario}`, async () => {
  const context = await browser.newContext();
  const egress: string[] = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    egress.push(route.request().url()); return route.abort();
  });
  try {
    const page = await context.newPage();
    const start = prompts.length;
    page.on("websocket", socket => socket.on("framereceived", ({ payload }) => { frames.push(JSON.parse(String(payload))); }));
    const sent: Array<{ type: string; draftId?: string; requestId?: string; attachments?: unknown[] }> = [];
    page.on("websocket", socket => socket.on("framesent", ({ payload }) => sent.push(JSON.parse(String(payload)))));
    await page.goto(`${origin}/?scenario=${encodeURIComponent(scenario)}`); await until(page, "window.shareDraft.connected()");
    await action(page, "stash"); await until(page, "window.shareDraft.state().queue === 1");
    await action(page, "confirm");
    await until(page, "window.shareDraft.state().draft?.messages.length === 2");
    const aBefore = await action<State>(page, "state");
    const aDraft = aBefore.draft!;
    expect(aDraft.messages[0]!.attachments).toHaveLength(1);
    expect(aDraft.messages[0]!.content).toContain("Penelope keeps the original loom plan.");
    const aSession = `odysseus-share-${start + 1}`;
    await waiting(aSession);
    expect(prompts[start]!.text).toContain("Penelope keeps the original loom plan.");
    let bId: string | undefined;
    let bBefore: State | undefined;
    if (scenario === "new chat B") { bId = await action<string>(page, "sendB"); bBefore = await action<State>(page, "state"); }
    if (bBefore) {
      expect(bBefore.draft!.messages[0]!.content).toBe("Ask Penelope about provisions");
      expect(bBefore.draft!.messages[0]!.attachments).toHaveLength(1);
    }
    if (scenario === "existing conversation") await action(page, "navigate");
    if (scenario === "new chat B") {
      await waiting(`odysseus-share-${start + 2}`);
      expect(prompts[start + 1]!.text).toContain("Ask Penelope about provisions");
    }
    await release(aSession);
    await until(page, "!window.shareDraft.state().busy");
    const afterA = await action<State>(page, "state");
    if (scenario === "new chat B") {
      expect(afterA.pending, "A must not consume B's pending draft identity").toBe(bId!);
      expect(afterA.active, "A admission must not navigate away from B").toBeNull();
      expect(afterA.draft).toEqual(bBefore!.draft);
    } else expect(afterA.active).toBe(scenario === "same draft" ? aSession : "odysseus-existing");
    expect(afterA.buffers[aSession]!.messages[0]).toEqual(aDraft.messages[0]!);
    expect(afterA.buffers[aSession]!.messages.some(m => m.content === "Ask Penelope about provisions")).toBe(false);
    expect(afterA.queue).toBe(0); expect(afterA.error).toBeNull();
    const aWire = sent.find(m => m.type === "chat_message")!;
    expect(aWire.draftId, "share send carries the real pending identity").toBe(aBefore.pending!);
    expect(aWire.draftId).toBeString();
    expect(frames.find(f => f.type === "session_info" && f.sessionId === aSession)).toMatchObject({ draftId: aWire.draftId, requestId: aWire.requestId });
    expect(prompts[start]!.images).toBe(1);
    if (scenario === "new chat B") {
      const bSession = `odysseus-share-${start + 2}`;
      await release(bSession); await until(page, `window.shareDraft.state().active === "${bSession}"`);
      const afterB = await action<State>(page, "state");
      expect(afterB.buffers[bSession]!.messages[0]).toEqual(bBefore!.draft!.messages[0]!);
      expect(afterB.buffers[aSession]!.messages[0]).toEqual(aDraft.messages[0]!);
      expect(afterB.pending).toBeNull(); expect(Object.keys(afterB.detached)).toHaveLength(0);
      expect(sent.filter(m => m.type === "chat_message")).toHaveLength(2);
      expect(frames.find(f => f.type === "session_info" && f.sessionId === bSession)?.draftId).toBe(bId!);
      expect(prompts[start + 1]!.images).toBe(1);
    }
    const previews = await action<Record<string, { width: number; pixel: number[] }>>(page, "previews");
    expect(previews[aSession]!.width).toBe(64);
    expect(previews[aSession]!.pixel[0]!).toBeLessThan(60);
    expect(previews[aSession]!.pixel[2]!).toBeGreaterThan(140);
    if (scenario === "new chat B") {
      const sample = previews[`odysseus-share-${start + 2}`]!;
      expect(sample.width).toBe(64);
      expect(sample.pixel[0]!).toBeGreaterThan(140);
      expect(sample.pixel[2]!).toBeLessThan(60);
    }
    expect(egress).toEqual([]);
  } finally {
    for (const release of gates.values()) release();
    gates.clear();
    await Promise.all([...app.wsHost.turnTasks]);
    await context.close();
  }
}, 30_000);
