import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareWorkerSandbox, workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";
import { operationalStateMasks } from "../src/brain/operational-state.js";

// /var/tmp is deliberately outside /tmp and HOST_MASKS: an ambient parent mask
// must not be what makes this database inaccessible. Every byte is fixture-owned.
test.each(["governed", "strict"] as const)("%s shared-uid worker masks the configured database while an unmasked same-uid control remains readable", profile => {
  const base = realpathSync("/var/tmp");
  expect(base).not.toBe("/tmp");
  const root = mkdtempSync(join(base, "odysseus-worker-identity-"));
  try {
    chmodSync(root, 0o700);
    const brain = join(root, "brain"), state = join(root, "server-state"), control = join(root, "unmasked-control");
    mkdirSync(brain); mkdirSync(state, { mode: 0o700 });
    const dbPath = join(state, "brain-ui.db");
    writeFileSync(dbPath, "Odysseus: private database bytes.\n", { mode: 0o600 });
    writeFileSync(control, "Odysseus: same uid can read this.\n", { mode: 0o600 });
    writeFileSync(join(brain, "harbor.md"), "Odysseus arrives.\n");
    const masks = operationalStateMasks({ brainPath: brain, dbPath });
    expect(masks, "CONFIGURED_DATABASE_DIRECTORY_MASK").toContain(state);
    const sandbox = prepareWorkerSandbox(brain, { profile, areas: [], maskPaths: masks, readPaths: [] });
    const python = Bun.which("python3", { PATH: "/usr/bin:/bin" }), unshare = Bun.which("unshare");
    expect(python).not.toBeNull(); expect(unshare).not.toBeNull();
    const program = `import json,os,pathlib,sys
try:
    pathlib.Path(sys.argv[1]).read_bytes()
    database="readable"
except OSError as error:
    database=error.errno
try:
    pathlib.Path("harbor.md").write_text("Odysseus departs.")
    brain_write=True
except OSError:
    brain_write=False
print(json.dumps({"uid":os.getuid(),"controlOwner":os.stat(sys.argv[2]).st_uid,"control":pathlib.Path(sys.argv[2]).read_text(),"database":database,"brainWrite":brain_write}))`;
    const argv = workerCommand({ brainPath: brain, sandbox, env: {}, command: [python!, "-I", "-S", "-c", program, dbPath, control] });
    // The real worker shares its parent's network as in production; that
    // parent's network is denied by this explicitly offline native harness.
    const child = Bun.spawnSync([unshare!, "--user", "--map-current-user", "--net", "--", ...argv],
      { cwd: "/", env: {}, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    // Compare identities in each namespace rather than treating a nested
    // uid_map parent ID as an initial-host UID. The map preserves file ownership.
    expect(statSync(control).uid, "HOST_OWNS_PRIVATE_CONTROL").toBe(process.getuid!());
    expect(result.uid, "WORKER_UID_MATCHES_CONTROL_OWNER").toBe(result.controlOwner);
    expect(result.control, "SAME_UID_UNMASKED_CONTROL").toBe("Odysseus: same uid can read this.\n");
    expect([2, 13], "CONFIGURED_DATABASE_BYTES_UNREADABLE").toContain(result.database);
    expect(result.brainWrite, "ORIGINAL_PROFILE_WRITE_RULE").toBe(profile === "governed");
    expect(readFileSync(join(brain, "harbor.md"), "utf8")).toBe(profile === "governed" ? "Odysseus departs." : "Odysseus arrives.\n");
    expect(readFileSync(dbPath, "utf8")).toBe("Odysseus: private database bytes.\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
