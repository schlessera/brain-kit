/** Local daemon controls for the one fixed CI build operation. */
import { spawnSync } from "node:child_process";
export function dockerControl(config: string, ...argv: string[]): string {
  const result = spawnSync("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", "--config", config, ...argv], {
    timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin" },
  });
  if (result.error || result.signal || result.status !== 0) throw new Error(`Fixed build Docker ${argv[0]} failed`);
  return result.stdout.toString("utf8").trim();
}
type Container = {
  Id: string; State: { Running: boolean }; Config: { Image: string; Labels: Record<string, string> };
  HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string; Privileged: boolean; CapDrop: string[]; SecurityOpt: string[]; Tmpfs: Record<string, string> };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
};
/** Names select an initial inspection only; all mutations use the verified ID. */
export function inspectOwnedBuildContainer(config: string, reference: string, session: string) {
  if (!/^[0-9a-f-]{36}$/.test(session) || (reference !== `brain-ci-build-${session}` && !/^[0-9a-f]{64}$/.test(reference))) throw new Error("Invalid build container ownership");
  const records = JSON.parse(dockerControl(config, "inspect", reference)) as Container[];
  const record = records[0];
  if (records.length !== 1 || !record || !/^[0-9a-f]{64}$/.test(record.Id) || record.Config?.Labels?.["brain-ci-build-session"] !== session || typeof record.State?.Running !== "boolean" || (/^[0-9a-f]{64}$/.test(reference) && record.Id !== reference)) throw new Error("Unknown container ownership");
  return { id: record.Id, running: record.State.Running, session, record };
}
/** Return only after this session's immutable container ID is absent. */
export function removeOwnedBuildContainer(config: string, reference: string, session: string): void {
  const owned = inspectOwnedBuildContainer(config, reference, session);
  if (owned.running) dockerControl(config, "stop", "--time", "5", owned.id);
  dockerControl(config, "wait", owned.id);
  dockerControl(config, "rm", owned.id);
  if (dockerControl(config, "container", "ls", "--all", "--no-trunc", "--filter", `id=${owned.id}`, "--format", "{{.ID}}") !== "") throw new Error("Owned build container removal unconfirmed");
}
