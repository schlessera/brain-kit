/**
 * Coordinator ownership (#2515): teardown settles everything a caller awaits,
 * and the session runner never imports the host that runs it for values.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentBackend, BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { createWsHandlers } from "../src/ws/connection";
import type { RunningTurn } from "../src/ws/turns";
import { closeDb, resetForTests, setBackendForTests, testHost } from "./helpers/test-host";
import { testPrincipal } from "./helpers/principal";

/**
 * How a request settled within a second: its rejection message, "resolved", or
 * "unsettled". A failure maximum: a request that settles wins the race at once,
 * and the 1 s branch is only reached by one that hangs.
 */
function settlement(request: Promise<unknown>): Promise<string> {
  return Promise.race([
    request.then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : String(error))),
    Bun.sleep(1_000).then(() => "unsettled"),
  ]);
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("host did not start the scripted turn");
}

describe("closing a host settles pending mask requests", () => {
  beforeEach(() => { resetForTests(); closeDb(); });
  afterEach(() => { resetForTests(); closeDb(); });

  test("a running turn's pending mask request rejects when the host closes", async () => {
    const bridges: BackendBridge[] = [];
    const backend: AgentBackend = {
      id: "fake",
      capabilities: { resume: true, permissions: true, thinking: true, attachments: true, askUser: true,
        costReporting: true, concurrentSessions: true, followUp: false },
      listProfiles: () => [{ id: "default", label: "Default" }],
      async startTurn({ bridge, signal }) {
        bridge.emit({ type: "session_info", sessionId: "aeaea", isNew: true });
        bridges.push(bridge);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      async listSessions() { return []; },
      async getHistory() { return []; },
    };
    setBackendForTests(backend);
    const host = testHost();
    const handlers = createWsHandlers(host, testPrincipal());
    await handlers.onOpen({} as Event, { send() {} });
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Mark the sail" }) } as MessageEvent, { send() {} });
    await until(() => bridges.length === 1);

    const mask = bridges[0]!.requestMask!("assets/sail.png", "The torn corner");
    await until(() => host.coordinator.pendingMask.size === 1);
    await host.close();

    expect(await settlement(mask), "MASK_SETTLED_ON_CLOSE").toBe("Server shutting down");
    expect(host.coordinator.pendingMask.size).toBe(0);
  });

  test("a mask request whose turn is not running still rejects when the host closes", async () => {
    setBackendForTests({ id: "fake" } as AgentBackend);
    const host = testHost();
    // A turn no slot owns: before #2515 the test-only reset() dropped such an
    // entry without settling it, and cancelAll() never reached it.
    const turn = { turnId: "circe-turn", sessionId: null } as RunningTurn;
    const mask = new Promise<Uint8Array>((resolve, reject) => {
      expect(host.coordinator.openMask("mask-circe", { turn, turnId: turn.turnId, resolve, reject })).toBe(true);
    });
    await host.close();

    expect(await settlement(mask), "MASK_SETTLED_ON_CLOSE").toBe("Server shutting down");
    expect(host.coordinator.pendingMask.size).toBe(0);
  });
});

/**
 * Relative imports a module needs at runtime. The TypeScript transpiler drops
 * `import type` and imports used only as types, exactly as Bun does when it
 * loads the module.
 */
function valueImports(file: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  return transpiler
    .scanImports(readFileSync(file, "utf8"))
    .map((entry) => entry.path)
    .filter((path) => path.startsWith("."))
    .map((path) => resolve(dirname(file), path.replace(/\.js$/, ".ts")));
}

describe("ws module graph", () => {
  const packageSrc = join(import.meta.dir, "../src");
  const src = join(packageSrc, "ws");

  test("run-session has no value import from host", () => {
    expect(valueImports(join(src, "run-session.ts"))).not.toContain(join(src, "host.ts"));
  });

  test("no value-import cycle leads from host back to host", () => {
    const host = join(src, "host.ts");
    const seen = new Set<string>();
    const cycles: string[][] = [];
    const walk = (file: string, path: string[]) => {
      for (const next of valueImports(file)) {
        if (next === host) cycles.push([...path, next]);
        else if (!seen.has(next) && next.startsWith(packageSrc)) {
          seen.add(next);
          walk(next, [...path, next]);
        }
      }
    };
    walk(host, [host]);
    expect(cycles.map((cycle) => cycle.map((file) => file.slice(packageSrc.length + 1)).join(" → "))).toEqual([]);
  });
});
