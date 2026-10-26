/** Native commands need OS isolation: the entire fixture has only loopback networking. */
import { expect, test } from "bun:test";
import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEASURED_RUNTIME } from "../src/measured-runtime.js";

interface Observation {
  fallback: boolean;
  profile: string;
  runtimeVersion: string;
  nativeMatches: boolean;
  nativeEnv: Record<string, string>;
  snapshots: { name: string; content: string }[];
  startup: string;
  debug: string;
  messages: { hook_event_name?: string; tool_response?: { stdout: string; stderr: string } }[];
  requests: { authorization: string; apiKey: string | null }[];
  credentialsProjected: boolean;
  hostHomeUnchanged: boolean;
  xdgWritePrivate: boolean;
  ledgerLive: number;
  namespace: string;
}

for (const [profile, startupEnv] of [["unprofiled", false], ["governed", false], ["strict", false], ["governed", true]] as const) for (const branch of ["snapshot", "fallback"]) {
  test(`real Claude ${profile} ${branch}${startupEnv ? " with admitted startup variables" : ""} imports no operator shell startup configuration`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "odysseus-shell-startup-"));
    const fixture = new URL("./fixtures/shell-startup-probe.ts", import.meta.url).pathname;
    try {
      const child = Bun.spawn(["bwrap", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/opt/odysseus-shell-fixture/home",
        "--unshare-net", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--tmpfs", "/opt",
        "--bind", scratch, "/opt/odysseus-shell-fixture", "--tmpfs", "/tmp", "--tmpfs", "/etc", "--proc", "/proc", "--dev", "/dev",
        process.execPath, fixture, "/opt/odysseus-shell-fixture", branch, profile, startupEnv ? "startup-env" : "clean-env"], {
        env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 30_000,
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr || stdout).toBe(0);
      const result = JSON.parse(stdout) as Observation;
      expect(result.runtimeVersion, "ACTUAL_SELECTED_CLAUDE_VERSION").toBe(MEASURED_RUNTIME.claudeCode);
      expect(result.nativeMatches, "ACTUAL_SDK_SELECTED_NATIVE_EXECUTABLE").toBe(true);
      expect(result.namespace, "NATIVE_FIXTURE_HAS_PRIVATE_NETWORK").not.toBe(readlinkSync("/proc/self/ns/net"));
      if (branch === "snapshot") {
        expect(result.debug, "NATIVE_SNAPSHOT_SUCCESS_ARM").toContain("Shell snapshot created successfully");
        expect(result.debug).toContain("Spawning shell without login (-l flag skipped)");
        expect(result.snapshots).toHaveLength(1);
      } else {
        expect(result.debug, "NATIVE_LOGIN_FALLBACK_ARM").toContain("EEXIST");
        expect(result.debug).not.toContain("Spawning shell without login (-l flag skipped)");
        expect(result.snapshots).toHaveLength(0);
      }
      const tool = result.messages.find(message => message.hook_event_name === "PostToolUse")?.tool_response;
      expect(tool, "NATIVE_BASH_COMMAND_EXECUTED").toBeDefined();
      expect(tool!.stdout, "CLAUDE_SHELL_STARTUP_ABSENT").toStartWith("hi\ngit is /usr/bin/git\nunset\nconfig=yes\n");
      expect(tool!.stdout).not.toMatch(/planted|ithaca-\.bash|\/planted-bin/);
      expect(tool!.stderr).toBe("");
      expect(result.startup, "OPERATOR_STARTUP_FILES_NEVER_RAN").toBe("");
      expect(result.credentialsProjected, "EXISTING_CLAUDE_CREDENTIAL_PROJECTION_UNCHANGED").toBe(true);
      expect(result.requests.length).toBeGreaterThanOrEqual(2);
      expect(result.requests.every(request => request.authorization === "Bearer odysseus-offline-oauth" && request.apiKey === null),
        "NATIVE_INFERENCE_USES_PREPARED_CREDENTIAL_WITHOUT_API_KEY").toBe(true);
      expect(tool!.stdout, "REAL_HOME_READS_AND_READ_ONLY_MOUNT_UNCHANGED").toContain("Odysseus returns to Ithaca.\nreal-home-read-only");
      expect(result.hostHomeUnchanged).toBe(true);
      expect(result.xdgWritePrivate, "XDG_WRITES_USE_PRIVATE_TURN_TEMP").toBe(true);
      expect(result.nativeEnv, "TURN_XDG_PATHS_UNCHANGED").toMatchObject({ HOME: "/tmp/brain-worker-state", CLAUDE_CONFIG_DIR: "/tmp/brain-worker-state",
        XDG_CONFIG_HOME: "/tmp/brain-worker-home/config", XDG_CACHE_HOME: "/tmp/brain-worker-home/cache", XDG_DATA_HOME: "/tmp/brain-worker-home/data" });
      if (startupEnv) for (const name of ["BASH_ENV", "ENV", "ZDOTDIR"]) expect(result.nativeEnv[name], "EXPLICIT_STARTUP_INPUT_WITHHELD").toBeUndefined();
      expect(result.ledgerLive, "SHELL_FIXTURE_RELEASES_ALL_RESERVATIONS").toBe(0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 35_000);
}
