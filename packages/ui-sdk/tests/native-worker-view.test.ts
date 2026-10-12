import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { launchAgentWorker, prepareWorkerSandbox } from "../src/server/worker-launcher";

const known = (text: string) => ({ status: "known" as const, hash: createHash("sha256").update(text).digest("hex") });
test("native observation matches a real strict worker's frozen reads and private area writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-view-")), brain = join(root, "brain");
  mkdirSync(join(brain, "workspaces"), { recursive: true });
  writeFileSync(join(brain, "helper.ts"), 'export default "Frozen voyage";');
  const path = join(brain, "workspaces/loom.md"); writeFileSync(path, "Penelope weaves.\n");
  const sandbox = prepareWorkerSandbox(brain, { profile: "strict", areas: ["workspaces"] });
  const worker = launchAgentWorker({ brainPath: brain, sandbox, env: {}, command: ["/bin/sh", "-c",
    'printf "ready\\n"; IFS= read -r go; cat helper.ts; printf "\\n"; printf "Athena charts.\\n" > /tmp/brain-worker-areas/workspaces/loom.md; printf "written\\n"; IFS= read -r end'] });
  void worker.exited.catch(() => {});
  let errors = ""; worker.stderr.on("data", chunk => { errors += String(chunk); });
  try {
    const [ready] = await once(worker.stdout, "data"); expect(String(ready)).toBe("ready\n");
    writeFileSync(join(brain, "helper.ts"), 'export default "New canonical voyage";');
    writeFileSync(path, "Penelope sleeps.\n");
    expect(worker.observeFile?.("helper.ts")?.version).toEqual(known('export default "Frozen voyage";'));
    expect(worker.observeFile?.("/tmp/brain-worker-areas/workspaces/loom.md")?.version).toEqual(known("Penelope weaves.\n"));
    let output = "";
    const written = Promise.withResolvers<void>();
    worker.stdout.on("data", chunk => { output += String(chunk); if (output.includes("written\n")) written.resolve(); });
    worker.stdin.write("go\n"); await written.promise;
    expect(output, "ACTUAL_STRICT_READ_MATCHES_NATIVE_OBSERVATION").toBe('export default "Frozen voyage";\nwritten\n');
    expect(worker.observeFile?.("/tmp/brain-worker-areas/workspaces/loom.md")).toEqual({ key: "workspaces/loom.md", version: known("Athena charts.\n") });
    expect(readFileSync(path, "utf8")).toBe("Penelope sleeps.\n");
    worker.stdin.end("end\n");
    await expect(worker.exited, errors).rejects.toThrow("stale maintenance output");
    expect(readFileSync(path, "utf8"), "STALE_PRIVATE_WRITE_NEVER_REPLACED_PEER_BYTES").toBe("Penelope sleeps.\n");
  } finally { worker.kill("SIGKILL"); await worker.exited.catch(() => {}); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
