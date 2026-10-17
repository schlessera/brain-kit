import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { createWorkerSpawn } from "../../ui-backend-claude/src/worker-spawn.js";
import { openPiWorkerSession } from "../src/worker-session.js";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

// Both production environment builders and real bubblewrap launches; only
// inference initialization is replaced by an offline protocol peer.
const previousPath = "/usr/bin:/bin:/usr/bin";
for (const backend of ["Claude", "Pi"] as const) for (const profile of ["governed", "strict", "restricted"] as const) for (const installed of [true, false]) {
  test(`${backend} native ${profile} worker PATH with CLI ${installed ? "installed" : "missing"}`, async () => {
    const root = mkdtempSync("/var/tmp/odysseus-cli-path-"), brain = join(root, "brain"), config = join(root, "config");
    mkdirSync(join(brain, "node_modules/.bin"), { recursive: true }); mkdirSync(config);
    writeFileSync(join(config, "settings.json"), "{}");
    const bin = join(brain, "node_modules/.bin"), cli = join(bin, "brain");
    if (installed) writeFileSync(cli, "#!/bin/sh\nprintf 'Odysseus CLI'\n", { mode: 0o755 });
    const view = profile !== "governed" ? createFixtureWorkerStartupView(brain) : undefined;
    const sandbox: worker.WorkerSandbox = { brain, profile, restricted: profile === "restricted", areas: [], scratchAliasesRemoved: [] };
    const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
    const oldPath = process.env.PATH, oldKey = process.env.ANTHROPIC_API_KEY, oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    process.env.ANTHROPIC_API_KEY = "sk-odysseus-offline";
    const inferenceDir = join(root, "inference"); mkdirSync(inferenceDir, { mode: 0o700 });
    process.env.PATH = previousPath;
    let spawner: ReturnType<typeof createWorkerSpawn> | undefined;
    let session: Awaited<ReturnType<typeof openPiWorkerSession>>["session"] | undefined;
    let launch: ReturnType<typeof spyOn> | undefined;
    let child: worker.LaunchedWorker | undefined;
    let relay: ReturnType<typeof Bun.serve> | undefined;
    try {
      if (backend === "Claude" && profile === "restricted") {
        relay = Bun.serve({ unix: join(inferenceDir, "relay.sock"), fetch: () => new Response("ithaca") });
        chmodSync(join(inferenceDir, "relay.sock"), 0o600);
      }
      const shell = 'found=$(command -v brain || true); printf "%s\\n" "$found"; if [ -n "$found" ]; then brain; fi; printf "\\n%s" "$PATH"';
      let actual: string;
      if (backend === "Claude") {
        spawner = createWorkerSpawn(brain, {}, new AbortController().signal, profile === "restricted" ? { inferenceDir } : undefined, sandbox, undefined, undefined,
          {}, undefined, undefined, view);
        const process = spawner.spawn({ command: "/bin/sh", args: ["-c", shell], env: { PATH: profile === "restricted" ? "/usr/bin:/bin" : previousPath, CLAUDE_CONFIG_DIR: config }, signal: new AbortController().signal } as never);
        const output: Buffer[] = [];
        process.stdout.on("data", chunk => output.push(Buffer.from(chunk)));
        process.stdin.end();
        const code = await new Promise((done, reject) => { process.once("exit", done); process.once("error", reject); });
        await spawner.finish();
        expect(code).toBe(0);
        actual = Buffer.concat(output).toString();
      } else {
        const nativeLaunch = worker.launchAgentWorker;
        const program = `let data = ""; for await (const chunk of process.stdin) { data += chunk; const end = data.indexOf("\\n"); if (end < 0) continue; const init = JSON.parse(data.slice(0, end)); const result = Bun.spawnSync(["/bin/sh", "-c", ${JSON.stringify(shell)}], { env: process.env }); if (result.exitCode) throw Error(result.stderr.toString()); console.log(JSON.stringify({ type: "ready", sessionId: init.sessionId, model: { id: result.stdout.toString() }, levels: [], cost: 0 })); break; } await Bun.sleep(30000);`;
        launch = spyOn(worker, "launchAgentWorker").mockImplementation(options => {
          child = nativeLaunch({ ...options, command: [process.execPath, "--no-env-file", "-e", program] });
          return child;
        });
        session = (await openPiWorkerSession({ brainPath: brain, model: "anthropic/claude-sonnet-4-6" }, join(root, "sessions"), {
          workerSandbox: sandbox, workerStartupView: view,
          ...(profile === "restricted" ? { autonomous: { origin: "autonomous" as const, persistence: "none" as const, containment: "restricted" as const, allowedTools: [], systemPromptAppend: "Odysseus offline fixture." } } : {}),
          caps: { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false },
        })).session;
        actual = session.model!.id;
      }
      const expectedPath = profile === "restricted" ? "/usr/bin:/bin" : `${bin}:${previousPath}`;
      const expectedCommand = installed && profile !== "restricted" ? `${cli}\nOdysseus CLI` : "\n";
      expect(actual, `${backend.toUpperCase()}_NATIVE_LOCAL_CLI_FIRST`).toBe(`${expectedCommand}\n${expectedPath}`);
      expect(process.env.PATH, "HOST_PATH_UNCHANGED").toBe(previousPath);
    } finally {
      try {
        session?.dispose(); child?.kill("SIGKILL"); await child?.exited.catch(() => {});
        await spawner?.finish().catch(() => {}); launch?.mockRestore(); probe.mockRestore();
        if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
        if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
        await view?.cleanup();
      } finally {
        try { relay?.stop(true); } finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  });
}
