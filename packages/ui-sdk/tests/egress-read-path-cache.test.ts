/**
 * The egress wrapper's read envelope is walked once per process (#4861): a
 * second launch lists no node_modules on the egress entry's ancestor chain,
 * and its sandbox command is the same as the first's.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import * as launcher from "../src/server/worker-launcher.js";
import type { WorkerSandbox } from "../src/server/worker-sandbox.js";

const root = fs.mkdtempSync("/tmp/odysseus-egress-read-paths-");
const brain = join(root, "brain"), proxyDir = join(root, "proxy");
let proxy: Server;
beforeAll(async () => {
  fs.mkdirSync(brain);
  fs.mkdirSync(proxyDir, { mode: 0o700 });
  fs.chmodSync(proxyDir, 0o700);
  proxy = createServer();
  await new Promise<void>(resolve => proxy.listen(join(proxyDir, "proxy.sock"), resolve));
  fs.chmodSync(join(proxyDir, "proxy.sock"), 0o600);
});
afterAll(() => { proxy.close(); fs.rmSync(root, { recursive: true, force: true }); });

/** Every existing node_modules directory on the egress entry's ancestor chain. */
function entryChainModules(): string[] {
  const chain: string[] = [];
  for (let dir = dirname(fs.realpathSync(Bun.resolveSync("../src/server/egress-worker-entry", import.meta.dir))); ; dir = dirname(dir)) {
    if (fs.existsSync(join(dir, "node_modules"))) chain.push(join(dir, "node_modules"));
    if (dirname(dir) === dir) return chain;
  }
}

function command(): string[] {
  const sandbox: WorkerSandbox = { brain, restricted: false, profile: "strict", areas: [], scratchAliasesRemoved: [], readPaths: [process.execPath] };
  return launcher.workerCommand({ brainPath: brain, command: [process.execPath, "-e", "0"], env: { PATH: "/usr/bin:/bin" }, sandbox, egress: { proxyDir } });
}

test("a second egress launch lists no node_modules on the egress entry's chain and builds the same command", () => {
  const modules = entryChainModules();
  expect(modules.length, "THE_ENTRY_HAS_AN_INSTALL_TO_WALK").toBeGreaterThan(0);
  const first = command();
  const listed: string[] = [];
  const actual = fs.readdirSync;
  const spy = spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    listed.push(String(path));
    return Reflect.apply(actual, fs, [path, ...rest]);
  }) as typeof fs.readdirSync);
  let second: string[];
  try { second = command(); } finally { spy.mockRestore(); }
  expect(listed.filter(path => modules.includes(path)), "SECOND_LAUNCH_DOES_NOT_REWALK_THE_INSTALL").toEqual([]);
  expect(second, "SAME_SANDBOX_COMMAND").toEqual(first);
});

test("appending to one launch's egress read paths never reaches the next launch", () => {
  // An existing directory: a read path that does not exist is never mounted, so it could not show.
  const appended = join(root, "suitors");
  fs.mkdirSync(appended, { recursive: true });
  const first = command();
  launcher.egressWorkerReadPaths().push(appended);
  const second = command();
  expect(second, "CACHED_READ_PATHS_ARE_NOT_SHARED").toEqual(first);
  expect(second).not.toContain(appended);
});
