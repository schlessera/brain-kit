/**
 * Pi's web tools, worker to host (#3685): a real offline child process speaks
 * the Pi worker protocol to the real Pi backend, whose host-side permission
 * gate and bridge tools forward each call through the ws web slice to the
 * real broker and a real fixture executor process. The launcher and its
 * probe are replaced, as in the other native worker fixtures: this proves
 * admission, forwarding, identity binding and recording, not OS containment.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { PermissionRequest, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import { createWebBroker, type WebBroker, type WebReceipt } from "../src/web-tools/broker.js";
import { createChildWebExecutor } from "../src/web-tools/child-executor.js";
import { createWebAccess } from "../src/ws/bridge-capabilities/web.js";

let root: string, brain: string, executorDir: string, broker: WebBroker, receipts: WebReceipt[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "odysseus-web-pi-"));
  brain = join(root, "brain"); executorDir = join(root, "executor");
  mkdirSync(join(brain, "notes"), { recursive: true }); mkdirSync(executorDir);
  receipts = [];
  broker = createWebBroker({
    executor: createChildWebExecutor({ launch: { command: [process.execPath, join(import.meta.dir, "fixtures/web-executor.ts")], env: { PATH: process.env.PATH!, WEB_FIXTURE_DIR: executorDir } } }),
    admittedProviders: () => ["exa"], onReceipt: receipt => receipts.push(receipt),
  });
});
afterEach(async () => { await broker.close(); rmSync(root, { recursive: true, force: true }); });

const executed = () => existsSync(join(executorDir, "calls.jsonl"))
  ? readFileSync(join(executorDir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];

async function piTurn(mode: string) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const controller = new AbortController(), frames: ServerMessage[] = [], cards: PermissionRequest[] = [];
  const begun: string[] = [];
  const exits: Promise<number>[] = [], children: Array<() => void> = [];
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async () => {
    // The worker receives no provider configuration: its environment is PATH only.
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/web-pi-worker.ts")], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH! } });
    children.push(() => { child.kill("SIGKILL"); });
    const exited = new Promise<number>((resolve, reject) => { child.once("exit", code => resolve(code ?? 128)); child.once("error", reject); });
    exits.push(exited);
    return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exited, kill: (signal?: NodeJS.Signals) => child.kill(signal),
      limitReport: () => ({ hits: [], fatal: false }), released: async () => {} } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  try {
    const backend = createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions") });
    const turnId = `odysseus-web-${mode}`;
    // What makeBridge composes for a governed Pi turn: the scope is this turn's, never the call's.
    const web = createWebAccess({ host: { webTools: broker }, turn: { sessionId: "s-ithaca" }, turnId, principalId: "p-penelope", signal: controller.signal,
      backendId: "pi", workerProfile: { origin: "interactive", actualProfile: "governed" }, current: () => !controller.signal.aborted,
      recordingAvailable: () => true } as never, { collectedSessionId: "s-ithaca" }, { policy: { hash: "rev-odyssey" } } as never);
    await backend.startTurn({ prompt: mode, signal: controller.signal, turnId,
      workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
      bridge: {
        emit(frame) { frames.push(frame); },
        requestPermission: async request => { cards.push(request); return { behavior: "allow" }; },
        inputSafety: {
          ready: async () => {}, unavailable: async () => {},
          begin: async (_id, tool) => { begun.push(tool); },
          result: async () => {},
        },
        webAccess: web.webAccess,
      } });
    expect(launch).toHaveBeenCalledTimes(1);
    await Promise.all(exits);
    const results = frames.filter((frame): frame is Extract<ServerMessage, { type: "tool_result" }> => frame.type === "tool_result");
    return { cards, results, begun, envelopes: results.map(frame => { try { return JSON.parse(frame.output); } catch { return frame.output; } }) };
  } finally {
    controller.abort();
    for (const stop of children) stop();
    await Promise.allSettled(exits);
    launch.mockRestore(); probe.mockRestore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("a Pi worker runs the four web tools only through the host, bound to the turn", async () => {
  const turn = await piTurn("typed");
  expect(turn.envelopes.map(envelope => `${envelope.tool}:${envelope.ok}`), "WEB_PI_FOUR_TOOLS_FORWARDED")
    .toEqual(["web_search:true", "get_search_content:true", "fetch_content:true", "source_check:true"]);
  expect(turn.envelopes[1].text, "WEB_PI_HANDLE_READS_OWN_RESULT").toContain("the raft reaches Ithaca at dawn");
  expect(JSON.stringify(turn.envelopes), "WEB_PI_UPSTREAM_ID_NEVER_IN_FRAMES").not.toContain("upstream-");
  // Auto-allowed like Claude's WebSearch/WebFetch: no card, but every call was admitted and recorded.
  expect(turn.cards, "WEB_PI_NO_CARD").toEqual([]);
  expect(turn.begun, "WEB_PI_EACH_CALL_BEGINS_RECORDING").toEqual(["web_search", "get_search_content", "fetch_content", "source_check"]);
  expect(executed().map(call => call.scope), "WEB_PI_EXECUTOR_SCOPE_IS_THE_TURNS").toEqual(Array.from({ length: 4 }, (_, index) => ({
    principalId: "p-penelope", sessionId: "s-ithaca", turnId: "odysseus-web-typed", toolCallId: `odysseus-web-${index}`, profile: "governed", policyRevision: "rev-odyssey" })));
  expect(receipts.filter(receipt => receipt.kind === "call").map(receipt => (receipt as { outcome: string }).outcome)).toEqual(["completed", "completed", "completed", "completed"]);
}, 30_000);

test("a forged bridge call never reaches the executor, and deferred features answer unsupported through the bridge", async () => {
  const forged = await piTurn("forged");
  expect(forged.results[0]!.output, "WEB_PI_FORGED_BRIDGE_REFUSED").toContain("no matching server permission decision");
  const unsupported = await piTurn("unsupported");
  expect(unsupported.envelopes, "WEB_PI_DEFERRED_UNSUPPORTED").toMatchObject([
    { ok: false, tool: "web_search", error: { code: "unsupported" } }, { ok: false, tool: "fetch_content", error: { code: "unsupported" } }]);
  expect(unsupported.results.every(result => result.isError)).toBe(true);
  expect(executed(), "WEB_PI_REFUSALS_NEVER_EXECUTE").toEqual([]);
}, 30_000);
