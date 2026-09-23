/**
 * The boot-time probe of the Claude Code binary a turn would spawn (#211).
 *
 * Fake binaries record every invocation, so these show what the probe RUNS:
 * only `--version`, of the binary the SDK itself selected, through the exec
 * wrapper with the turn's environment and working directory — and that a
 * binary which is missing or will not answer refuses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MEASURED_RUNTIME } from "../src/measured-runtime";
import { backendModule } from "../src/module";
import {
  ClaudeRuntimeUnavailableError,
  installedAgentSdkVersion,
  isMeasuredRuntime,
  probeClaudeRuntime,
} from "../src/runtime-probe";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A fake `claude` that appends its argv to `log` and prints `output`. */
function fakeBinary(dir: string, name: string, output: string, exitCode = 0): { path: string; log: string } {
  const path = join(dir, name);
  const log = join(dir, `${name}.log`);
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho ${JSON.stringify(output)}\nexit ${exitCode}\n`
  );
  chmodSync(path, 0o755);
  return { path, log };
}

function invocations(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

const env = () => ({ PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmpdir(), PROBE_MARK: "turn-env" });

describe("probeClaudeRuntime", () => {
  test("runs only --version of a native CLAUDE_CODE_PATH, and reports it", () => {
    const dir = tempDir("probe-native-");
    const fake = fakeBinary(dir, "claude", `${MEASURED_RUNTIME.claudeCode} (Claude Code)`);
    const report = probeClaudeRuntime({ claudeCodePath: fake.path, brainPath: dir, env: env(), exec: {} });

    expect(invocations(fake.log)).toEqual(["--version"]);
    expect(report.runtime).toEqual({
      name: "claude-code",
      version: MEASURED_RUNTIME.claudeCode,
      command: fake.path,
      hostProvided: true,
    });
    expect(report.sdk?.version).toBe(MEASURED_RUNTIME.agentSdk);
    expect(report.measured?.matches).toBe(true);
  });

  test("keeps the interpreter and script of a JavaScript CLAUDE_CODE_PATH, and only swaps the session flags", () => {
    const dir = tempDir("probe-js-");
    const log = join(dir, "cli.log");
    const script = join(dir, "cli.js");
    writeFileSync(
      script,
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\nconsole.log("9.9.9 (Claude Code)");\n`
    );
    const report = probeClaudeRuntime({ claudeCodePath: script, brainPath: dir, env: env(), exec: {} });

    expect(invocations(log)).toEqual(["--version"]);
    expect(report.runtime.version).toBe("9.9.9");
    expect(report.measured?.matches).toBe(false);
  });

  test("an interpreter answering for a script it could not run is not taken for Claude Code", () => {
    // A script path the interpreter reads as its own flag: the interpreter
    // prints ITS version. That must refuse, not pass as Claude's.
    const dir = tempDir("probe-dash-");
    writeFileSync(join(dir, "-cli.js"), `console.log("7.7.7 (Claude Code)");\n`);
    expect(() => probeClaudeRuntime({ claudeCodePath: "-cli.js", brainPath: dir, env: env(), exec: {} })).toThrow(
      ClaudeRuntimeUnavailableError
    );
  });

  test("with CLAUDE_CODE_PATH unset it probes what the SDK selects, not a `claude` on PATH", () => {
    const dir = tempDir("probe-unset-");
    const decoy = fakeBinary(dir, "claude", "0.0.1 (Claude Code)");
    const report = probeClaudeRuntime({
      brainPath: dir,
      env: { ...env(), PATH: `${dir}:${env().PATH}` },
      exec: {},
    });

    expect(invocations(decoy.log)).toEqual([]);
    expect(report.runtime.command).toContain("@anthropic-ai/claude-agent-sdk-");
    expect(report.runtime.hostProvided).toBe(false);
    expect(report.runtime.version).toBe(MEASURED_RUNTIME.claudeCode);
  });

  test("goes through the exec wrapper, with the turn's environment and working directory", () => {
    const dir = tempDir("probe-wrap-");
    const fake = fakeBinary(dir, "claude", "2.0.0 (Claude Code)");
    const wrapperLog = join(dir, "wrapper.log");
    const wrapper = join(dir, "wrapper");
    writeFileSync(
      wrapper,
      // CLAUDE_CODE_ENTRYPOINT is set by the SDK, not by us: seeing it proves
      // the probe runs with the environment the SDK would give a turn.
      `#!/bin/sh\necho "argv=$* cwd=$(pwd) mark=$PROBE_MARK entrypoint=$CLAUDE_CODE_ENTRYPOINT" >> ${JSON.stringify(wrapperLog)}\nexec "$@"\n`
    );
    chmodSync(wrapper, 0o755);
    probeClaudeRuntime({ claudeCodePath: fake.path, brainPath: dir, env: env(), exec: { wrapper } });

    expect(invocations(wrapperLog)).toEqual([
      `argv=${fake.path} --version cwd=${dir} mark=turn-env entrypoint=sdk-ts`,
    ]);
    expect(invocations(fake.log)).toEqual(["--version"]);
  });

  test("the module probes with the environment the default profile's turn gets, model aliases included", () => {
    const dir = tempDir("probe-profile-env-");
    const log = join(dir, "env.log");
    const path = join(dir, "claude");
    writeFileSync(
      path,
      `#!/bin/sh\necho "opus=$ANTHROPIC_DEFAULT_OPUS_MODEL subagent=$CLAUDE_CODE_SUBAGENT_MODEL key=\${ANTHROPIC_API_KEY-unset}" >> ${JSON.stringify(log)}\necho "2.0.0 (Claude Code)"\n`
    );
    chmodSync(path, 0o755);
    backendModule.probeRuntime!({
      brainPath: dir,
      config: { claudeCodePath: path, defaultModel: "claude-probe-model" },
      profiles: [],
      confirmBashPatterns: null,
      settings: {},
    });

    expect(invocations(log)).toEqual(["opus=claude-probe-model subagent=claude-probe-model key="]);
  });

  test("a binary that does not exist refuses, naming the path", () => {
    const dir = tempDir("probe-missing-");
    const missing = join(dir, "no-such-claude");
    expect(() => probeClaudeRuntime({ claudeCodePath: missing, brainPath: dir, env: env(), exec: {} })).toThrow(
      ClaudeRuntimeUnavailableError
    );
    expect(() => probeClaudeRuntime({ claudeCodePath: missing, brainPath: dir, env: env(), exec: {} })).toThrow(
      missing
    );
  });

  test("a binary that exits non-zero on --version refuses, with what it said", () => {
    const dir = tempDir("probe-broken-");
    const fake = fakeBinary(dir, "claude", "cannot load libc", 3);
    expect(() => probeClaudeRuntime({ claudeCodePath: fake.path, brainPath: dir, env: env(), exec: {} })).toThrow(
      /exited 3 on --version: cannot load libc/
    );
  });
});

describe("installedAgentSdkVersion", () => {
  test("reads the version of the SDK copy it resolved, not the measured constant", () => {
    const dir = tempDir("sdk-copy-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.999" }));
    expect(installedAgentSdkVersion(join(dir, "sdk.mjs"))).toBe("0.3.999");
  });
});

describe("isMeasuredRuntime", () => {
  test("a binary that ignores SIGTERM past the deadline refuses at the deadline", () => {
    const dir = tempDir("probe-stuck-");
    const path = join(dir, "claude");
    // Answers at once, then will not exit and ignores the polite signal.
    writeFileSync(path, `#!/bin/sh\ntrap "" TERM\necho "2.0.0 (Claude Code)"\nsleep 8\n`);
    chmodSync(path, 0o755);
    const started = Date.now();
    expect(() => probeClaudeRuntime({ claudeCodePath: path, brainPath: dir, env: env(), exec: {} })).toThrow(
      /did not answer --version within 5 s/
    );
    expect(Date.now() - started).toBeLessThan(7_000);
  });

  test("is the measured pair only when BOTH halves are", () => {
    expect(isMeasuredRuntime(MEASURED_RUNTIME.claudeCode, MEASURED_RUNTIME.agentSdk)).toBe(true);
    // The same CLI under a different SDK is a different pair.
    expect(isMeasuredRuntime(MEASURED_RUNTIME.claudeCode, "0.3.999")).toBe(false);
    expect(isMeasuredRuntime("2.1.999", MEASURED_RUNTIME.agentSdk)).toBe(false);
    expect(isMeasuredRuntime(undefined, MEASURED_RUNTIME.agentSdk)).toBe(false);
  });
});
