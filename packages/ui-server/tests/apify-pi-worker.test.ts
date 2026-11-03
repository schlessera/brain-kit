/**
 * Pi's Apify path, worker to host (#3162): a real offline child process
 * speaks the Pi worker protocol to the real Pi backend, whose host-side
 * permission gate and bridge tools forward each call to a real hosted Apify
 * service on a loopback fake. The launcher and its probe are replaced, as in
 * the other native worker fixtures: this proves admission, forwarding and the
 * host's decisions, not OS containment or live inference.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { PermissionRequest, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createPiBackend } from "../../ui-backend-pi/src/backend.js";
import type { ApifyHost } from "../src/apify/host.js";
import { APIFY_LIMITS, APIFY_SENTINEL, apifyPolicy, fakeApify, fixtureApifyHost, type FakeApify } from "./fixtures/apify-host-fixture.js";

let root: string, brain: string, fake: FakeApify, host: ApifyHost;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "odysseus-apify-pi-"));
  brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  mkdirSync(join(root, "private"), { mode: 0o700 });
  fake = fakeApify();
  host = fixtureApifyHost(brain, fake, join(root, "private", "apify-ledger.sqlite"));
});
afterEach(() => { host.close(); fake.stop(); rmSync(root, { recursive: true, force: true }); });

async function piTurn(mode: string, options: { noGrantSurface?: boolean } = {}) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const controller = new AbortController(), frames: ServerMessage[] = [], cards: PermissionRequest[] = [], calls: string[] = [];
  const exits: Promise<number>[] = [], children: Array<() => void> = [];
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async () => {
    // The worker receives no Apify credential: its environment is PATH only.
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/apify-pi-worker.ts")], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH! } });
    children.push(() => { child.kill("SIGKILL"); });
    const exited = new Promise<number>((resolve, reject) => { child.once("exit", code => resolve(code ?? 128)); child.once("error", reject); });
    exits.push(exited);
    return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exited, kill: (signal?: NodeJS.Signals) => child.kill(signal),
      limitReport: () => ({ hits: [], fatal: false }), released: async () => {} } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  try {
    const backend = createPiBackend({ brainPath: brain, sessionDir: join(root, "sessions") });
    const turnId = `odysseus-apify-${mode}`;
    await backend.startTurn({ prompt: mode, signal: controller.signal, turnId, ...(options.noGrantSurface ? { noGrantSurface: true, enforceAllowedTools: true } : {}),
      workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
      bridge: {
        emit(frame) { frames.push(frame); },
        // The approval card the host's consent raises for an exact operation.
        requestPermission: async request => { cards.push(request); return { behavior: "allow" }; },
        // What the ws bridge does: the context is this turn's, never the call's.
        apify: call => { calls.push(call.tool); return host.call({ turnId, principalId: "p-penelope", sessionId: () => "s-voyage", posture: "interactive",
          approvals: { requestPermission: async request => { cards.push(request as PermissionRequest); return { behavior: "allow" }; } }, signal: controller.signal }, call); },
      } });
    expect(launch).toHaveBeenCalledTimes(1);
    await Promise.all(exits);
    const results = frames.filter((frame): frame is Extract<ServerMessage, { type: "tool_result" }> => frame.type === "tool_result");
    return { frames, cards, calls, results, envelopes: results.map(frame => { try { return JSON.parse(frame.output); } catch { return frame.output; } }) };
  } finally {
    controller.abort();
    for (const stop of children) stop();
    await Promise.allSettled(exits);
    launch.mockRestore(); probe.mockRestore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("a Pi worker discovers, reviews, runs and reads results only through the host", async () => {
  apifyPolicy(brain, { enabled: true, discovery: "ask", actors: "ask", limits: APIFY_LIMITS });
  const turn = await piTurn("typed");
  expect(turn.calls, "APIFY_PI_EVERY_STEP_REACHES_HOST").toEqual(["brain_apify_discover", "brain_apify_inspect", "brain_apify_prepare", "brain_apify_run", "brain_apify_results"]);
  expect(turn.envelopes.map(envelope => envelope.ok), "APIFY_PI_SEQUENCE_SUCCEEDS").toEqual([true, true, true, true, true]);
  // No tool-level card: the host asked per exact use, discovery and inspection included, and the run once.
  expect(turn.cards.map(card => `${card.kind}:${card.toolName}`), "APIFY_PI_PER_USE_REVIEW")
    .toEqual(["command:Apify catalog search", "command:Apify Actor inspection", "command:Apify Actor run"]);
  expect(turn.envelopes[4].data.items, "APIFY_PI_BOUNDED_RESULTS").toHaveLength(2);
  expect(fake.starts(), "APIFY_PI_ONE_START").toBe(1);
  expect(JSON.stringify(turn.frames), "APIFY_PI_SENTINEL_NEVER_IN_FRAMES").not.toContain(APIFY_SENTINEL);
}, 30_000);

test("a disabled provider refuses through the Pi worker exactly as elsewhere", async () => {
  apifyPolicy(brain, null);
  const turn = await piTurn("typed");
  expect(turn.envelopes, "APIFY_PI_DISABLED").toMatchObject([{ ok: false, error: { code: "provider_disabled" } }]);
  expect(turn.results[0]).toMatchObject({ isError: true });
  expect(fake.seen).toEqual([]);
}, 30_000);

test("a turn without a grant surface and a forged bridge call never reach the host", async () => {
  apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "ask", limits: APIFY_LIMITS });
  const nogrant = await piTurn("nogrant", { noGrantSurface: true });
  expect(nogrant.calls, "APIFY_PI_NO_GRANT_SURFACE_MEMBERSHIP").toEqual([]);
  expect(nogrant.results[0]!.output).toContain("requires an interactive typed grant surface");
  const forged = await piTurn("forged");
  expect(forged.calls, "APIFY_PI_FORGED_BRIDGE_REFUSED").toEqual([]);
  expect(forged.results[0]!.output).toContain("no matching server permission decision");
  expect(fake.seen).toEqual([]);
}, 30_000);
