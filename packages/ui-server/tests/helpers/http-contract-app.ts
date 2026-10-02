import { spyOn } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "@schlessera/brain-ui-server/package.json";

import { createApp, type CreateAppOptions } from "../../src/app";
import { createStaticBackendRegistry } from "../../src/agent/backend";
import { resolveServerConfig } from "../../src/config/env";
import { createRecordingObservability } from "../../src/observability";
import { makeFakeBackend } from "./fake-backend";

/** A real composition root with disposable files and no vendor discovery. */
export async function httpContractApp(options: {
  env?: Record<string, string>;
  staticRoot?: boolean;
  renderer?: CreateAppOptions["renderer"];
  registry?: CreateAppOptions["registry"];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "brain-http-contract-"));
  const brainPath = join(root, "brain");
  const staticRoot = join(root, "static");
  mkdirSync(join(brainPath, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(brainPath, "notes"));
  mkdirSync(staticRoot);
  writeFileSync(join(brainPath, "notes", "arrival.md"), "# Arrival\n\nOdysseus reaches the harbor.\n");
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Contract fixture</title><main>Harbor</main>");
  writeFileSync(join(staticRoot, "fixture.css"), "main { color: #123456; }");
  // Resolve the same repo-local executable as production; startup/prune stay
  // keyless, and tests may replace this fixture to exercise CLI pass-through.
  writeFileSync(join(brainPath, "node_modules", ".bin", "brain"),
    `#!${process.execPath}\nimport { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "cli.jsonl"))}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) console.log(${JSON.stringify(version)});
else if (args[0] === "search") console.log(JSON.stringify({results:[{path:"notes/arrival.md",title:"Arrival",type:"note",relevance:"high",score:1,snippet:"Odysseus reaches the harbor."}],warnings:["Fixture uses keyless retrieval"]}));
else if (args[0] === "list") console.log(JSON.stringify([{path:"notes/arrival.md",title:"Arrival",type:"note",status:"active",relevance:"high",tags:null,score:0,snippet:"",summary:null,updated:"2026-09-28"}]));
else if (args[0] === "stats") console.log(JSON.stringify(args.includes("--history") ? {history:[{date:"2026-09-28",documents:1,embeddings:null}]} : {documents:1,embeddings:null}));
else if (args[0] === "briefing") console.log("Arrival: Odysseus reaches the harbor.");
else if (args[0] === "add") console.log(JSON.stringify({action:"created",path:"notes/arrival.md",title:"Arrival",type:"note",indexed:false,indexError:"Fixture indexing is unavailable"}));
else if (args[0] === "sync") console.log("Fixture sync complete");
`,
    { mode: 0o755 });
  const config = resolveServerConfig({
    AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: ":memory:", BRAIN_PATH: brainPath,
    BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_COASTLINE: "0", VOICE_PROVIDER: "webspeech",
    ...options.env,
  });
  const observability = createRecordingObservability();
  const backend = makeFakeBackend({ id: "fixture",
    sessions: [{ id: "fixture-session", title: "Arrival", createdAt: 1, lastActiveAt: 2, totalCostUsd: 0, numTurns: 1 }],
    histories: { "fixture-session": [{ role: "assistant", content: "Odysseus reaches the harbor.", toolCalls: [] }] },
  });

  // Observe the Hono instance actually used by createApp, preserving every
  // real mount. Its public routes collection includes direct /ws and SPA
  // handlers as well as the routers; no production inspection seam is needed.
  let mounted: Hono | undefined;
  const originalRoute = Hono.prototype.route;
  const observer = spyOn(Hono.prototype, "route").mockImplementation(function (this: Hono, ...args) {
    const result = Reflect.apply(originalRoute, this, args);
    mounted = result;
    return result;
  });
  let app: Awaited<ReturnType<typeof createApp>>;
  try {
    app = await createApp({
      config, observability,
      registry: options.registry ?? createStaticBackendRegistry([backend]),
      ...(options.staticRoot ? { staticRoot } : {}),
      ...(options.renderer ? { renderer: options.renderer } : {}),
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    observer.mockRestore();
  }
  if (!mounted) {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    throw new Error("createApp did not mount any real routers");
  }
  const routes = mounted.routes.map(({ method, path }) => ({ method, path: path === "*" ? "/*" : path }));
  return {
    app, root, brainPath, staticRoot, routes, observability,
    fetch: (path: string, init?: RequestInit) => app.fetch(new Request(new URL(path, "http://localhost"), init)),
    async close() {
      try { await app.close(); }
      finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
}

export type HttpContractApp = Awaited<ReturnType<typeof httpContractApp>>;
