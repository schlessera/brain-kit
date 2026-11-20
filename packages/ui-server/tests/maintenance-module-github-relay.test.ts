/**
 * A credential-free maintenance worker reaches the module GitHub relay (#4259)
 * under real bubblewrap: the relay's socket is bound read-only at
 * `/run/brain-github`, the worker holds no token and no network, and its
 * request reaches the loopback GitHub stand-in with the host's token.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { startModuleGitHubRelay } from "../src/github/module-relay.js";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";

const ROOT = resolve(import.meta.dir, "../../..");
const TOKEN = "odysseus-module-github-token";
let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ path: string; authorization: string | null }> = [];
let root: string, brain: string;
const cleanup: Array<() => Promise<void> | void> = [];

beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
    return Response.json([{ number: 7, title: "Watchtower lamp" }]);
  } });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  root = mkdtempSync(join(ROOT, "tmp/maintenance-module-github-"));
  brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\nTelemachus keeps the watchtower lit.\n");
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); seen.length = 0; });
afterAll(() => { upstream.stop(true); rmSync(root, { recursive: true, force: true }); });

test("a credential-free maintenance worker reaches the relay through its socket, holding no token and no network", async () => {
  const state = mkdtempSync(join(root, "state-"));
  const native = createNativeAppFixture(brain); cleanup.push(native.close);
  const host = createHostBoundary({ brainPath: brain, dbPath: join(state, "ui.db"), exec: {}, nativeManager: createNativeBrainManagerClient(native.nativeBrain) });
  const relay = startModuleGitHubRelay({ token: () => TOKEN, repositories: ["ithaca/watchtower"], writes: new Map(), origin: upstream.url.origin });
  cleanup.push(() => relay.stop());
  const program = `const socket = process.env.BRAIN_MODULE_GITHUB_SOCKET;
    const relayed = await fetch("http://localhost/repos/ithaca/watchtower/issues", { unix: socket }).then(r => r.status, e => String(e));
    const direct = await fetch(${JSON.stringify(upstream.url.origin)} + "/repos/ithaca/watchtower/issues").then(r => r.status, () => "unreachable");
    const fs = require("node:fs");
    const proc = { environ: fs.readFileSync("/proc/self/environ", "utf8"), cmdline: fs.readFileSync("/proc/self/cmdline", "utf8") };
    console.log(JSON.stringify({ socket, relayed, direct, env: process.env, proc, relayDir: fs.readdirSync("/run/brain-github") }));`;
  // A misconfigured host that hands the job the relay's token anyway: it never reaches the worker.
  const child = await host.launch({ argv: [process.execPath, "--config=/dev/null", "-e", program], env: { PATH: "/usr/bin:/bin", BRAIN_UI_MODULE_GITHUB_TOKEN: TOKEN },
    credentials: false, gate: "shared", purpose: "Odysseus module job", githubRelay: relay.dir });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  const observed = JSON.parse(stdout.trim().split("\n").at(-1)!) as { socket: string; relayed: number | string; direct: number | string; env: Record<string, string>;
    proc: { environ: string; cmdline: string }; relayDir: string[] };
  expect(observed.env.BRAIN_UI_MODULE_GITHUB_TOKEN, "WORKER_ENV_HAS_NO_TOKEN").toBeUndefined();
  expect(`${observed.proc.environ}${observed.proc.cmdline}`, "WORKER_PROCESS_HAS_NO_TOKEN").not.toContain(TOKEN);
  expect(observed.relayDir, "RELAY_DIR_HOLDS_ONLY_THE_SOCKET").toEqual(["github.sock"]);
  expect(observed.socket, "WORKER_SOCKET_PATH").toBe("/run/brain-github/github.sock");
  expect(observed.relayed, "WORKER_REACHES_RELAY").toBe(200);
  expect(observed.direct, "WORKER_HAS_NO_NETWORK").toBe("unreachable");
  expect(stdout, "WORKER_HOLDS_NO_TOKEN").not.toContain(TOKEN);
  expect(seen, "RELAY_ADDS_HOST_TOKEN").toEqual([{ path: "/repos/ithaca/watchtower/issues", authorization: `Bearer ${TOKEN}` }]);
}, 120_000);
