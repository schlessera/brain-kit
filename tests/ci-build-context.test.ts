import { expect, spyOn, test } from "bun:test";
import * as child from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildContextCleanupError, observeBuildContext } from "../scripts/ci-build-context";

for (const fault of ["none", "daemon-drift", "producer-exit", "malformed", "cleanup", "receipt", "cleanup-receipt"] as const) test(`actual context transport fails closed: ${fault}`, () => {
  const state = mkdtempSync(join(tmpdir(), "odysseus-context-")), id = "a".repeat(64), image = "fixed-image";
  const kernel = { affinity: "0-1", boot: "b".repeat(64), kernel: "c".repeat(64), version: "d".repeat(64) }, node = "e".repeat(64);
  const calls: string[][] = []; let session = "", info = 0, removed = false;
  if (fault.includes("receipt")) writeFileSync(join(state, "context.json"), "owned existing receipt");
  const spawn = spyOn(child, "spawnSync").mockImplementation(((exe: string, args: string[], options: any) => {
    expect(exe).toBe("/usr/bin/docker"); expect(options.timeout).toBe(10_000);
    expect(args.slice(0, 4)).toEqual(["--host", "unix:///var/run/docker.sock", "--config", "/owned/config"]);
    const argv = args.slice(4); calls.push(argv); let out = "";
    if (argv[0] === "info") out = JSON.stringify({ ID: fault === "daemon-drift" && info++ ? "other" : "owned", ServerVersion: "fixed", KernelVersion: "fixed", OSType: "linux", Architecture: "x86_64" });
    if (argv[0] === "create") { session = argv[argv.indexOf("--label") + 1]!.split("=")[1]!; out = id; }
    if (argv[0] === "inspect") out = JSON.stringify([{ Id: id, State: { Running: false, ExitCode: fault === "producer-exit" ? 1 : 0 }, Config: { Image: image, User: `${process.getuid!()}:${process.getgid!()}`, Labels: { "brain-ci-build-session": session } }, HostConfig: { ReadonlyRootfs: true, NetworkMode: "none", Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] }, Mounts: [] }]);
    if (argv[0] === "start") out = fault === "malformed" ? "{}" : JSON.stringify({ kernel, node });
    if (argv[0] === "rm") removed = true;
    if (argv[0] === "container") out = fault.startsWith("cleanup") ? id : "";
    return { status: 0, signal: null, stdout: Buffer.from(out), stderr: Buffer.alloc(0) };
  }) as typeof child.spawnSync);
  try {
    if (fault === "none") {
      const result = observeBuildContext("/owned/config", image, state);
      expect(result.binding.kernel).toEqual(kernel); expect(result.binding.node).toBe(node);
      expect(result.removed).toBe(true);
    } else if (fault.startsWith("cleanup")) expect(() => observeBuildContext("/owned/config", image, state)).toThrow(BuildContextCleanupError);
    else expect(() => observeBuildContext("/owned/config", image, state)).toThrow();
    expect(removed, "CONTEXT_REFUSAL_STILL_DRAINS_OWNED_CONTAINER").toBe(true);
    for (const argv of calls.filter(argv => ["start", "stop", "wait", "rm"].includes(argv[0]!))) expect(argv.at(-1), "CONTEXT_CONTROLS_ONLY_VERIFIED_ID").toBe(id);
    if (fault.includes("receipt")) expect(readFileSync(join(state, "context.json"), "utf8")).toBe("owned existing receipt");
    else if (fault !== "cleanup") expect(JSON.parse(readFileSync(join(state, "context.json"), "utf8")).success).toBe(fault === "none");
  } finally { spawn.mockRestore(); rmSync(state, { recursive: true }); }
});
