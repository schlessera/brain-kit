/**
 * The pi worker's read envelope is walked once per process (#4861): two
 * restricted autonomous launches list each node_modules directory on the pi
 * worker entry's ancestor chain at most once between them. The launch is
 * captured before any process starts.
 */
import { tmpdir } from "node:os";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { openPiWorkerSession } from "../src/worker-session.js";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

/** Every existing node_modules directory on the pi worker entry's ancestor chain. */
function entryChainModules(): string[] {
  const chain: string[] = [];
  for (let dir = dirname(fs.realpathSync(Bun.resolveSync("../src/worker-entry", import.meta.dir))); ; dir = dirname(dir)) {
    if (fs.existsSync(join(dir, "node_modules"))) chain.push(join(dir, "node_modules"));
    if (dirname(dir) === dir) return chain;
  }
}

test("two restricted pi launches list the worker entry's node_modules at most once between them", async () => {
  const modules = entryChainModules();
  expect(modules.length, "THE_ENTRY_HAS_AN_INSTALL_TO_WALK").toBeGreaterThan(0);
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-pi-read-paths-")), brain = join(root, "brain");
  fs.mkdirSync(brain);
  const view = createFixtureWorkerStartupView(brain);
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const oldKey = process.env.ANTHROPIC_API_KEY, oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
  process.env.ANTHROPIC_API_KEY = "sk-odysseus-offline";
  const captured: Parameters<typeof worker.launchAgentWorker>[0][] = [];
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async options => { captured.push(options); throw new Error("LAUNCH_CAPTURED"); });
  const listed = new Map<string, number>();
  const actual = fs.readdirSync;
  const readdir = spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    listed.set(String(path), (listed.get(String(path)) ?? 0) + 1);
    return Reflect.apply(actual, fs, [path, ...rest]);
  }) as typeof fs.readdirSync);
  try {
    for (let turn = 0; turn < 2; turn++) {
      await expect(openPiWorkerSession({ brainPath: brain, model: "anthropic/claude-sonnet-4-6" }, join(root, `sessions-${turn}`), {
        workerStartupView: view,
        autonomous: { origin: "autonomous", persistence: "none", containment: "restricted", allowedTools: [], systemPromptAppend: "Odysseus offline fixture." },
        caps: { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false },
      })).rejects.toThrow("LAUNCH_CAPTURED");
    }
    expect(captured.map(options => options.restricted !== undefined), "BOTH_LAUNCHES_ARE_RESTRICTED").toEqual([true, true]);
    expect(modules.filter(path => (listed.get(path) ?? 0) > 1), "ENTRY_INSTALL_WALKED_AT_MOST_ONCE").toEqual([]);
    expect(captured[1]!.restricted!.readPaths, "SAME_READ_ENVELOPE").toEqual(captured[0]!.restricted!.readPaths);
  } finally {
    readdir.mockRestore(); launch.mockRestore(); probe.mockRestore();
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await view.cleanup(); fs.rmSync(root, { recursive: true, force: true });
  }
});
