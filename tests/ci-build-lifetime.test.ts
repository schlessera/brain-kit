import { expect, spyOn, test } from "bun:test";
import * as child from "node:child_process";
import { dockerControl, removeOwnedBuildContainer } from "../scripts/ci-build-lifetime";
const session = "00000000-0000-4000-8000-000000000001", name = `brain-ci-build-${session}`;
for (const failure of ["none", "rm", "still-present", "foreign"] as const) test(`owned fixed-build cleanup ${failure}`, () => {
  const calls: string[][] = [];
  const spawn = spyOn(child, "spawnSync").mockImplementation(((exe: string, args: string[], options: any) => {
    expect(exe).toBe("/usr/bin/docker"); expect(options.timeout, "CI_BUILD_DOCKER_CONTROL_BOUNDED").toBe(10_000); expect(options.killSignal).toBe("SIGKILL");
    expect(args.slice(0, 4)).toEqual(["--host", "unix:///var/run/docker.sock", "--config", "/owned/config"]);
    const argv = args.slice(4); calls.push(argv);
    const out = argv[0] === "inspect" ? JSON.stringify([{ State: { Running: true }, Config: { Labels: { "brain-ci-build-session": failure === "foreign" ? "foreign" : session } } }]) : argv[0] === "container" && failure === "still-present" ? name : "";
    return { status: argv[0] === "rm" && failure === "rm" ? 1 : 0, signal: null, stdout: Buffer.from(out), stderr: Buffer.alloc(0) };
  }) as typeof child.spawnSync);
  try {
    if (failure === "none") { removeOwnedBuildContainer("/owned/config", name, session); expect(calls.map(argv => argv[0])).toEqual(["inspect", "stop", "wait", "rm", "container"]); }
    else expect(() => removeOwnedBuildContainer("/owned/config", name, session), "CI_BUILD_CLEANUP_FAILURE_REFUSES_SUCCESS").toThrow();
    if (failure === "foreign") expect(calls).toHaveLength(1);
  } finally { spawn.mockRestore(); }
});
test("timed-out local Docker control fails closed", () => {
  const spawn = spyOn(child, "spawnSync").mockReturnValue({ status: null, signal: "SIGKILL", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) } as any);
  try { expect(() => dockerControl("/owned/config", "inspect", name), "CI_BUILD_CONTROL_TIMEOUT_REFUSES_SUCCESS").toThrow("failed"); }
  finally { spawn.mockRestore(); }
});
