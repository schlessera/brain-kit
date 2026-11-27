/**
 * One owner for the browser host a ui-react runtime test stands up (#4841):
 * where Chrome is, what happens without it, and the package build, scratch
 * brain, client bundle, page, app, server and Chrome launch that every such
 * file used to write out for itself.
 *
 *   const executablePath = chromePath("tracker-runtime.test.ts");
 *   beforeAll(async () => {
 *     if (!executablePath) return;
 *     host = await startRuntimeHost({ file: "tracker-runtime.test.ts", executablePath, packages: ["ui-react"],
 *       client: resolve(import.meta.dir, "fixtures/tracker-runtime-client.ts"), page: INDEX_HTML,
 *       app: { backend, config: ({ brain, db }) => resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: db, … }) } });
 *   });
 *   afterAll(() => host?.close());
 */
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { createStaticBackendRegistry, type ServerConfig } from "@schlessera/brain-ui-server";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createFixtureApp } from "../../../ui-server/tests/helpers/native-app-fixture.js";
import { createFixtureBrain } from "../../../../scripts/captures/core-fixture.ts";
import { watchdogMs } from "../../../../scripts/test-deadlines";
import { runtimeHookPhases } from "./runtime-hook-phases";
import { runtimePackageBuild } from "./runtime-package-build";

const repo = resolve(import.meta.dir, "../../../..");

/** Where Chrome is looked for after the two variables production honours too (`CHROME_PATH_FALLBACKS`, ui-render-puppeteer). */
export const CHROME_PATHS = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] as const;
export const CHROME_REQUIRED = "BRAIN_REQUIRE_CHROME=1 and no Chrome: set PUPPETEER_EXECUTABLE_PATH or BRAIN_UI_CHROME_PATH";

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const warned = new Set<string>();

/**
 * The Chrome a runtime test launches: `PUPPETEER_EXECUTABLE_PATH`, then
 * `BRAIN_UI_CHROME_PATH`, then the well-known paths. Without one the test
 * file skips with one warning naming it, unless `BRAIN_REQUIRE_CHROME=1`
 * (hosted proof, `check:pr --full`), where it throws (CONTRIBUTING.md).
 */
export function chromePath(name: string, env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = isFile): string | undefined {
  const found = [env.PUPPETEER_EXECUTABLE_PATH, env.BRAIN_UI_CHROME_PATH, ...CHROME_PATHS].find((path) => path && exists(path));
  if (found) return found;
  if (env.BRAIN_REQUIRE_CHROME === "1") throw new Error(CHROME_REQUIRED);
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`SKIPPING ${name}: no Chrome; its browser proof did not run here. Set PUPPETEER_EXECUTABLE_PATH or BRAIN_UI_CHROME_PATH.`);
  }
  return undefined;
}

type FixtureApp = Awaited<ReturnType<typeof createFixtureApp>>;
type AppOptions = NonNullable<Parameters<typeof createFixtureApp>[0]>;

/** The scratch layout a test may seed or read: the fixture brain and the served directory. */
export interface RuntimePaths { scratch: string; brain: string; assets: string }

export interface RuntimeHostOptions {
  /** The test file, for the setup receipts. */
  file: string;
  executablePath: string;
  /** Packages whose `dist` the client and the host read (`runtimePackageBuild`). */
  packages: readonly string[];
  /** The browser entry, bundled to `/client.js`. */
  client: string;
  /** `/index.html`; a function is called once the app is up, for a page that embeds what the app seeded. */
  page: string | ((app: FixtureApp | undefined, paths: RuntimePaths) => Promise<string>);
  scratchPrefix: string;
  /** Writes into the fixture brain or the served directory before the app opens them. */
  seed?: (paths: RuntimePaths) => Promise<void>;
  /** The app under test. Absent: the served directory alone, with `/index.html` for any other path. */
  app?: Omit<AppOptions, "config" | "registry" | "staticRoot"> & {
    backend: AgentBackend;
    config: (paths: { brain: string; db: string }) => ServerConfig;
    /** The request handler the server uses; the app's own by default. */
    fetch?: (app: FixtureApp) => (request: Request) => Response | Promise<Response>;
  };
  chromeArgs?: readonly string[];
}

export interface RuntimeHost extends RuntimePaths {
  origin: string;
  browser: Browser;
  /** The app, when the options named one. */
  app: FixtureApp | undefined;
  /** Releases the browser, server, app and scratch directory, in that order; later steps still run when one fails. */
  close(): Promise<void>;
}

/** Starts the host; a step that fails releases what the earlier ones made before the error is thrown. */
export async function startRuntimeHost(options: RuntimeHostOptions): Promise<RuntimeHost> {
  const hook = runtimeHookPhases(options.file);
  const releases: Array<() => unknown> = [];
  const close = () => hook.phase("cleanup", async () => {
    const failures: unknown[] = [];
    for (const release of releases.splice(0).reverse()) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `${failures.length} runtime host releases failed`);
  });
  try {
    return await hook.phase("setup", async () => {
      // Browser consumers follow the published default exports, which resolve to
      // dist. Build those outputs; never force a Bun condition in the consumer.
      await runtimePackageBuild(repo, options.packages, hook);
      const scratch = await mkdtemp(join(tmpdir(), options.scratchPrefix));
      releases.push(() => rm(scratch, { recursive: true, force: true }));
      const paths = { scratch, brain: resolve(scratch, "brain"), assets: resolve(scratch, "assets") };
      if (options.app) await hook.phase("fixture-brain", () => createFixtureBrain(repo, paths.brain));
      await mkdir(paths.assets);
      if (options.seed) await hook.phase("fixture-seed", () => options.seed!(paths));
      const bundle = Bun.spawn([process.execPath, "-e", 'const result = await Bun.build({entrypoints:[process.argv[1]],target:"browser",outdir:process.argv[2],naming:"client.js"}); if(!result.success){console.error(result.logs);process.exit(1);}', options.client, paths.assets],
        { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [bundleOut, bundleErr, bundleCode] = await hook.child("client-build", bundle);
      if (bundleCode !== 0) throw new Error(`Runtime client build failed (${bundleCode}): ${bundleOut}\n${bundleErr}`);
      for (const [file, pkg] of [["kit.css", "ui-kit"], ["app.css", "ui-react"]] as const) {
        await writeFile(resolve(paths.assets, file), await readFile(resolve(repo, `packages/${pkg}/dist/styles.css`)));
      }
      let app: FixtureApp | undefined;
      if (options.app) {
        const { backend, config, fetch, ...rest } = options.app;
        app = await hook.phase("host-start", () => createFixtureApp({ ...rest, config: config({ brain: paths.brain, db: resolve(scratch, "ui.db") }),
          registry: createStaticBackendRegistry([backend], backend.id), staticRoot: paths.assets }));
        const started = app;
        releases.push(async () => { started.cancelActiveTurns(); await started.close(); });
      }
      await hook.phase("page", async () => writeFile(resolve(paths.assets, "index.html"), typeof options.page === "string" ? options.page : await options.page(app, paths)));
      const server = app
        ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: options.app!.fetch?.(app) ?? app.fetch, websocket: app.websocket })
        : Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
          const path = join(paths.assets, new URL(request.url).pathname);
          return new Response(Bun.file(isFile(path) ? path : join(paths.assets, "index.html")));
        } });
      releases.push(() => server.stop(true));
      const browser = await hook.phase("chrome-launch", () => chromium.launch({ executablePath: options.executablePath, headless: true,
        args: [...(options.chromeArgs ?? ["--no-sandbox", "--disable-dev-shm-usage"])], timeout: watchdogMs(120_000) }));
      releases.push(() => browser.close());
      return { ...paths, origin: `http://127.0.0.1:${server.port}`, browser, app, close };
    });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
