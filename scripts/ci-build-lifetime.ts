/** Local daemon controls for the one fixed CI build operation. */
import { spawnSync } from "node:child_process";
export function dockerControl(config: string, ...argv: string[]): string {
  const result = spawnSync("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", "--config", config, ...argv], {
    timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) throw new Error(`Fixed build Docker ${argv[0]} failed`);
  return result.stdout.toString("utf8").trim();
}
/** Return only after this session's container is removed and absence verified. */
export function removeOwnedBuildContainer(config: string, name: string, session: string): void {
  if (!/^[0-9a-f-]{36}$/.test(session) || name !== `brain-ci-build-${session}`) throw new Error("Invalid build container ownership");
  const status = JSON.parse(dockerControl(config, "inspect", name)) as Array<{ State: { Running: boolean }; Config: { Labels: Record<string, string> } }>;
  if (status.length !== 1 || status[0]!.Config.Labels["brain-ci-build-session"] !== session) throw new Error("Unknown container ownership");
  if (status[0]!.State.Running) dockerControl(config, "stop", "--time", "5", name);
  dockerControl(config, "wait", name);
  dockerControl(config, "rm", name);
  if (dockerControl(config, "container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}") !== "") throw new Error("Owned build container removal unconfirmed");
}
