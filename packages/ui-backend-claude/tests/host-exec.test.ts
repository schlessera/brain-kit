import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend.js";
import { backendModule } from "../src/module.js";
import * as factory from "../src/backend.js";
import { createWorkerSpawn } from "../src/worker-spawn.js";

mockWorkerHostForSdkStream();

test("Claude factory/module turns carry host exec to runtime probe and SDK worker argv (#1429)", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-host-exec-"));
  const brain = join(root, "brain"), home = join(root, "home");
  mkdirSync(brain); mkdirSync(home);
  const binary = join(root, "claude");
  writeFileSync(binary, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
  const wrappers = ["a", "b", "c"].map(name => {
    const path = join(root, name), log = join(root, name + ".log");
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexec "$@"\n`, { mode: 0o755 });
    return { path, log };
  });
  const [a, b, c] = wrappers as [typeof wrappers[number], typeof wrappers[number], typeof wrappers[number]];
  const oldWrapper = process.env.BRAIN_UI_EXEC_WRAPPER;
  const oldConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.BRAIN_UI_EXEC_WRAPPER = b.path;
  process.env.CLAUDE_CONFIG_DIR = home;
  const commands: string[][] = [];
  const stop = new Error("controlled worker launch boundary");
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async input => {
    commands.push([...input.command]);
    throw stop;
  });
  const queryFn = (({ options }: any) => ({
    initializationResult: async () => ({}),
    async *[Symbol.asyncIterator]() {
      const child = options.spawnClaudeCodeProcess({ command: binary, args: ["--offline-turn"],
        env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home },
        signal: new AbortController().signal });
      await new Promise((_, reject) => child.once("error", reject));
      yield {};
    },
  })) as never;
  const construct = createClaudeBackend;
  // Keep module-owned construction, injecting only the keyless provider collaborator.
  const constructor = spyOn(factory, "createClaudeBackend").mockImplementation(options => construct({ ...options, queryFn }));
  try {
    for (const module of [false, true]) {
      for (const exec of [{ wrapper: a.path, killer: "/bin/true" }, { wrapper: c.path }, {}, undefined]) {
        process.env.BRAIN_UI_EXEC_WRAPPER = b.path;
        const options = { brainPath: brain, claudeCodePath: binary, exec, queryFn,
          versionRequirements: { runtime: "2.1.283" }, log: () => {} };
        const resolved = module ? await backendModule.resolveFromEnv({
          brainPath: brain, config: { claudeCodePath: binary, modelDiscovery: false }, exec,
          versionRequirements: options.versionRequirements, profiles: [], settings: {}, confirmBashPatterns: [],
        }) : null;
        if (resolved && !resolved.ok) throw resolved.error;
        const backend = resolved?.ok ? resolved.value.backend : construct(options);
        if (exec === undefined) process.env.BRAIN_UI_EXEC_WRAPPER = c.path;
        const frames: unknown[] = [];
        await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal,
          workerSandbox: worker.prepareWorkerSandbox(brain, { home, profile: "governed", areas: [] }),
          bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } });
        const expected = exec === undefined ? c.path : exec.wrapper;
        expect(commands.at(-1), exec === undefined ? "OMITTED_HOST_EXEC_REMAINS_LIVE" : "SDK_WORKER_HOST_ARGV").toEqual([
          ...(expected ? [expected] : []), binary, "--offline-turn",
        ]);
        expect(frames.some((frame: any) => frame.type === "error" && frame.message.includes(stop.message))).toBe(true);
      }
    }
    for (const [wrapper, count] of [[a, 2], [b, 0], [c, 4]] as const) {
      expect(existsSync(wrapper.log), "PER_TURN_PROBE_USED_HOST_WRAPPER").toBe(count > 0);
      expect(existsSync(wrapper.log) ? readFileSync(wrapper.log, "utf8").trim().split("\n") : []).toEqual(
        Array.from({ length: count }, () => [binary, "--version"]).flat(),
      );
    }
  } finally {
    constructor.mockRestore(); launch.mockRestore();
    if (oldWrapper === undefined) delete process.env.BRAIN_UI_EXEC_WRAPPER; else process.env.BRAIN_UI_EXEC_WRAPPER = oldWrapper;
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ordinary Claude worker refuses a nonregular host wrapper before any worker (#1429)", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-host-exec-dir-"));
  const helpers = join(root, "helpers"), linked = join(root, "linked");
  mkdirSync(helpers); symlinkSync(helpers, linked);
  const launch = spyOn(worker, "launchAgentWorkerAsync");
  try {
    for (const wrapper of [helpers, linked]) {
      expect(() => createWorkerSpawn(root, { wrapper }, new AbortController().signal), "CLAUDE_WORKER_WRAPPER_REGULAR")
        .toThrow(/exec wrapper .* regular file/);
    }
    // The restricted envelope launches no operator wrapper, so it does not consult one.
    expect(() => createWorkerSpawn(root, { wrapper: helpers }, new AbortController().signal, { inferenceDir: join(root, "relay") })).not.toThrow();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    launch.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
