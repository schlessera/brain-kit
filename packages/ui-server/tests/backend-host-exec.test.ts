import { mockWorkerHostForSdkStream } from "../../ui-backend-claude/tests/helpers/worker-host.js";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as claude from "../../ui-backend-claude/src/backend.js";
import * as pi from "../../ui-backend-pi/src/backend.js";
import { createFixtureApp } from "./helpers/native-app-fixture.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createRecordingObservability } from "../src/observability/index.js";

mockWorkerHostForSdkStream();

for (const backendId of ["claude", "pi"] as const) test(`apps pass their host wrapper to ${backendId} turns, including empty/absent compatibility (#1429)`, async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-app-exec-"));
  const old = process.env.BRAIN_UI_EXEC_WRAPPER;
  const wrap = (name: string) => {
    const path = join(root, name), log = join(root, name + ".log");
    // Boot maintenance runs with a private /tmp; only record when the host
    // path exists. Backend probes/tools below run at their real spawn boundary.
    writeFileSync(path, `#!/bin/sh\nif [ -d '${root}' ]; then printf '%s\\n' "$@" >> '${log}'; fi\nexec "$@"\n`, { mode: 0o755 });
    return { path, log };
  };
  const a = wrap("a"), b = wrap("b"), c = wrap("c");
  process.env.BRAIN_UI_EXEC_WRAPPER = b.path;
  const binary = join(root, "claude");
  writeFileSync(binary, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
  const makeClaude = claude.createClaudeBackend, makePi = pi.createPiBackend;
  const queryFn = (() => ({
    initializationResult: async () => ({}), getSettings: async () => ({ effective: {}, sources: [] }),
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", session_id: "odysseus", claude_code_version: "9.9.9" };
      yield { type: "result", subtype: "success", session_id: "odysseus", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    },
  })) as never;
  const claudeFactory = spyOn(claude, "createClaudeBackend").mockImplementation(options => makeClaude({ ...options, queryFn }));
  const piFactory = spyOn(pi, "createPiBackend").mockImplementation(options => makePi({
    ...options, sessionFactory: {
      async newSession(_profile, toolkit) {
        return { sessionId: "odysseus", subscribe: () => () => {},
          async prompt() {
            const result = await toolkit!.tools.find(t => t.name === "bash")!.execute("host-exec",
              { command: "echo Ithaca" }, undefined, undefined, {} as never);
            expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Ithaca") }]);
          },
          abort: async () => {}, dispose() {}, getSessionStats: () => ({ cost: 0 }),
        };
      },
      async openSession() { throw new Error("new turns only"); },
    },
  }));
  const apps: Awaited<ReturnType<typeof createFixtureApp>>[] = [];
  const failures: unknown[] = [];
  try {
    for (const [index, exec] of [{ wrapper: a.path }, { wrapper: c.path }, {}, undefined].entries()) {
      const brain = join(root, "brain-" + index);
      mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
      writeFileSync(join(brain, "node_modules/.bin/brain"), '#!/bin/sh\necho "0.44.0"\n', { mode: 0o755 });
      const config = resolveServerConfig({ NODE_ENV: "test", AUTH_MODE: "none", HOST: "127.0.0.1",
        DB_PATH: ":memory:", BRAIN_PATH: brain, AGENT_BACKEND: backendId, CLAUDE_CODE_PATH: binary,
        PI_MODEL: "anthropic/claude-sonnet-4-5", BRAIN_UI_PRICING_DISCOVERY: "0" });
      config.exec = exec;
      apps.push(await createFixtureApp({ config, observability: createRecordingObservability(),
        versionRequirements: backendId === "claude" ? { backends: { claude: { runtime: "2.1.283" } } } : {} }));
    }
    // Both A and C exist before either runs: constructing C must not retarget A.
    for (const app of apps) {
      const backend = await app.wsHost.registry.getDefaultBackend();
      const frames: any[] = [];
      await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal,
        bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } });
      expect(frames.at(-1), "APP_BACKEND_TURN_COMPLETES").toMatchObject({ type: "result", outcome: "success" });
    }
    for (const wrapper of [a, b, c]) {
      expect(existsSync(wrapper.log), "APP_HOST_WRAPPER_USED").toBe(true);
      const lines = readFileSync(wrapper.log, "utf8").trim().split("\n");
      if (backendId === "claude") {
        expect(lines.filter(line => line === binary), "APP_RUNTIME_PROBE_WRAPPER").toHaveLength(3);
      } else {
        expect(lines.filter(line => line === "echo Ithaca"), "APP_PI_BASH_WRAPPER").toHaveLength(1);
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    const cleanup = [
      ...apps.reverse().map(app => () => app.close()),
      () => claudeFactory.mockRestore(),
      () => piFactory.mockRestore(),
      () => { if (old === undefined) delete process.env.BRAIN_UI_EXEC_WRAPPER; else process.env.BRAIN_UI_EXEC_WRAPPER = old; },
      () => rmSync(root, { recursive: true, force: true }),
    ];
    for (const action of cleanup) { try { await action(); } catch (error) { failures.push(error); } }
  }
  if (failures.length) throw new AggregateError(failures, "App fixture or cleanup failed");
});
