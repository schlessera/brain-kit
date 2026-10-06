import sharp from "sharp";

import { chromium, type Page } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  createApp,
  createRecordingObservability,
  createStaticBackendRegistry,
  resolveServerConfig,
} from "@schlessera/brain-ui-server";
import type {
  AgentBackend,
  StartTurnRequest,
} from "@schlessera/brain-ui-sdk/server";
import { askUserFormSpec } from "@schlessera/brain-ui-sdk/internal/client";
import { createFixtureBrain } from "../../captures/core-fixture.ts";

/** Finite, keyless evidence harness for #942; it changes only its disposable fixture. */
export async function createHarness(phase: string) {
  const output = resolve(process.argv[2] ?? "/tmp/brain-navigation-recovery");
  const gate = { hold: false, held: [] as Array<() => void> };
  const repo = resolve(import.meta.dir, "../../..");
  const executablePath = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => statSync(p, { throwIfNoEntry: false })?.isFile());
  if (!executablePath) throw Error("Real Chromium missing");
  const scratch = await mkdtemp("/tmp/odysseus-navigation-");
  const assets = resolve(scratch, "client"),
    brain = resolve(scratch, "brain");
  await mkdir(assets);
  await createFixtureBrain(repo, brain);
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "client.tsx")],
    target: "browser",
    outdir: assets,
    naming: "client.js",
  });
  if (!bundle.success) throw Error(JSON.stringify(bundle.logs));
  for (const [name, pkg] of [
    ["kit", "ui-kit"],
    ["app", "ui-react"],
  ])
    await writeFile(
      resolve(assets, `${name}.css`),
      await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`))
    );
  await writeFile(
    resolve(assets, "index.html"),
    '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/client.js"></script></body></html>'
  );
  const histories = new Map<string, any[]>([
    [
      "odysseus-B",
      [
        { role: "user", content: "Sail plan", toolCalls: [] },
        { role: "assistant", content: "The sail is ready.", toolCalls: [] },
      ],
    ],
    [
      "odysseus-A",
      [
        { role: "user", content: "Raft supplies", toolCalls: [] },
        {
          role: "assistant",
          content: "Timber and rope are packed.",
          toolCalls: [],
        },
      ],
    ],
  ]);
  const controls = new Map<
    string,
    { request: StartTurnRequest; finish: (error?: boolean) => void }
  >();
  const starts: Array<{ sessionId: string; prompt: string }> = [];
  let sequence = 0;
  let app: Awaited<ReturnType<typeof createApp>>;
  const backend: AgentBackend = {
    id: "odysseus-scripted",
    capabilities: {
      resume: true,
      permissions: true,
      thinking: true,
      attachments: true,
      askUser: true,
      costReporting: false,
      concurrentSessions: true,
      followUp: false,
    },
    listProfiles: () => [{ id: "odysseus-scripted", label: "Local fixture" }],
    async listSessions() {
      return [...histories.keys()].map((id) => ({
        id,
        title: id,
        createdAt: 1,
        lastActiveAt: Date.now(),
        totalCostUsd: 0,
        numTurns: histories.get(id)!.length / 2,
      }));
    },
    async getHistory(id) {
      if (id === "missing") throw Error("Fixture history unavailable");
      return histories.get(id) ?? [];
    },
    async startTurn(request) {
      const sid = request.sessionId ?? `odysseus-live-${++sequence}`;
      starts.push({ sessionId: sid, prompt: request.prompt });
      const previous = histories.get(sid) ?? [];
      histories.set(sid, [
        ...previous,
        { role: "user", content: request.prompt, toolCalls: [] },
      ]);
      request.bridge.emit({
        type: "session_info",
        sessionId: sid,
        isNew: !request.sessionId,
      });
      request.bridge.emit({
        type: "text_delta",
        sessionId: sid,
        text: `Working on ${request.prompt}.`,
      });
      let finish!: () => void;
      const done = new Promise<void>((r) => {
        finish = r;
      });
      controls.set(sid, {
        request,
        finish: (error = false) => {
          histories.set(sid, [
            ...histories.get(sid)!,
            {
              role: "assistant",
              content: error
                ? "Fixture failure"
                : `Completed ${request.prompt}.`,
              toolCalls: [],
            },
          ]);
          request.bridge.emit({
            type: "result",
            sessionId: sid,
            isError: error,
            outcome: error ? "error" : "success",
            durationMs: 1,
            numTurns: 1,
          });
          finish();
        },
      });
      request.signal.addEventListener("abort", finish, { once: true });
      if (request.prompt === "approval") {
        await request.bridge.requestPermission({
          toolUseId: `write-${sid}`,
          toolName: "Write",
          input: { file_path: "notes/raft.md", content: "Timber and rope" },
          kind: "command",
          description: "Record raft supplies",
        });
      } else if (request.prompt === "ask") {
        await request.bridge.askUser!(`ask-${sid}`, [
          {
            question: "Which raft supply?",
            header: "Supplies",
            options: [
              { label: "Rope", description: "Pack rope" },
              { label: "Timber", description: "Pack timber" },
            ],
            multiSelect: false,
          },
        ]);
      } else if (request.prompt === "list") {
        await request.bridge.askUserList!(`list-${sid}`, {
          prompt: "Classify raft supplies",
          items: [{ id: "rope", label: "Rope" }],
          scale: [{ label: "Pack" }, { label: "Leave" }],
          allowSkip: false,
          notes: false,
        });
      } else if (request.prompt === "rank") {
        await request.bridge.askUserRank!(`rank-${sid}`, {
          prompt: "Order raft supplies",
          items: [
            { id: "rope", label: "Rope" },
            { id: "timber", label: "Timber" },
          ],
        });
      } else if (request.prompt === "form") {
        await request.bridge.askUserForm!(
          `form-${sid}`,
          askUserFormSpec({
            prompt: "Record raft supplies",
            nodes: [
              {
                id: "note",
                kind: "text",
                prompt: "Supply note",
                required: true,
              },
            ],
          })
        );
      }
      await done;
      controls.delete(sid);
    },
  };
  const requests: Array<{ path: string; method: string }> = [];
  app = await createApp({
    config: resolveServerConfig({
      BRAIN_PATH: brain,
      DB_PATH: resolve(scratch, "ui.db"),
      AUTH_MODE: "none",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      BRAIN_UI_PRICING_DISCOVERY: "0",
      BRAIN_UI_MODEL_DISCOVERY: "0",
      MAX_CONCURRENT_SESSIONS: "20",
    }),
    staticRoot: assets,
    registry: createStaticBackendRegistry([backend], backend.id),
    observability: createRecordingObservability(),
    turnTimeoutMs: 600_000,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: app.websocket,
    fetch: (req, srv) => {
      const path = new URL(req.url).pathname;
      requests.push({ path, method: req.method });
      if (path === "/api/brain/sync" || path === "/api/brain/whatsup")
        return new Response(
          "data: " +
            JSON.stringify({ type: "text", text: "Fixture-only raft report" }) +
            "\n\n",
          { headers: { "Content-Type": "text/event-stream" } }
        );
      return app.fetch(req, srv);
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  await mkdir(output, { recursive: true });
  const results: any = {
    blockedExternalRequests: 0,
    source: await new Response(
      Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout
    )
      .text()
      .then((value) => value.trim()),
    browser: browser.version(),
    navigation: [],
    faults: [],
    draft: [],
    host: [],
  };
  const state = (p: Page) => p.evaluate(() => (window as any).probe.state());
  async function reset(p: Page, occupied = true) {
    await p.evaluate((x) => (window as any).probe.reset(x), occupied);
    await p.waitForTimeout(200);
  }
  async function open(width: number, coarse: boolean, theme: string) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: coarse,
      isMobile: coarse,
      colorScheme: theme as any,
      reducedMotion: "reduce",
    });
    await context.route("**/*", (r) => {
      if (new URL(r.request().url()).origin === origin) return r.continue();
      results.blockedExternalRequests++;
      return r.abort();
    });
    await context.routeWebSocket("**/*", (s) => {
      if (new URL(s.url()).origin === origin.replace("http", "ws")) {
        const remote = s.connectToServer();
        remote.onMessage((data) => {
          if (gate.hold) gate.held.push(() => s.send(data));
          else s.send(data);
        });
      } else {
        results.blockedExternalRequests++;
        s.close();
      }
    });
    await context.addInitScript(() => {
      const Original = window.WebSocket;
      Object.assign(window, { probeSockets: [], probeWire: [] });
      window.WebSocket = class extends Original {
        constructor(...args: any[]) {
          super(...(args as [string]));
          (window as any).probeSockets.push(this);
          this.addEventListener("message", (e) => {
            try {
              (window as any).probeWire.push(JSON.parse(e.data));
            } catch {}
          });
        }
      };
    });
    const p = await context.newPage();
    p.on("pageerror", (e) => results.faults.push(e.message));
    await p.goto(origin);
    await p.waitForFunction("window.probe?.ready()");
    await p.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    return p;
  }
  const persist = () =>
    writeFile(
      resolve(output, phase + ".json"),
      JSON.stringify(results, null, 2)
    );
  const attachment = {
    name: "odysseus-raft.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#cfa462" },
    })
      .png()
      .toBuffer(),
  };
  async function composer(p: Page) {
    return {
      text: await p.locator("textarea").inputValue(),
      attachments: await p
        .getByRole("button", { name: "Remove odysseus-raft.png", exact: true })
        .count(),
      active: (await state(p)).active,
    };
  }
  async function draft(p: Page) {
    await p.locator("textarea").fill("Unsent raft plan");
    await p
      .locator('input[type="file"][accept="image/*"][multiple]')
      .setInputFiles(attachment);
    await p
      .getByRole("button", { name: "Remove odysseus-raft.png", exact: true })
      .waitFor();
  }
  async function palette(p: Page, label: string) {
    await p.keyboard.press("Control+k");
    await p.getByRole("option", { name: new RegExp(label) }).click();
    await p.waitForTimeout(200);
  }
  async function summary(p: Page) {
    return p.evaluate(() => {
      const s = (window as any).probe.state();
      return {
        active: s.active,
        pendingDraftId: s.pendingDraftId,
        runStates: s.runStates,
        buffers: Object.fromEntries(
          Object.entries(s.buffers).map(([id, b]: any) => [
            id,
            {
              messages: b.messages.length,
              streaming: b.isStreaming,
              ask: b.askUser?.requestId ?? null,
              approvals: b.messages
                .flatMap((m: any) => m.toolCalls)
                .filter((t: any) => t.status === "pending_approval").length,
              text: b.messages.map((m: any) => m.content),
            },
          ])
        ),
      };
    });
  }

  async function close() {
    gate.hold = false;
    for (const send of gate.held.splice(0)) send();
    await persist();
    await browser.close();
    server.stop(true);
    app.cancelActiveTurns();
    await app.close();
    await rm(scratch, { recursive: true, force: true });
  }
  return {
    app,
    browser,
    results,
    state,
    reset,
    open,
    summary,
    composer,
    draft,
    palette,
    persist,
    close,
    controls,
    starts,
    requests,
    origin,
    gate,
    output,
  };
}
