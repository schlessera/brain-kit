import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareWorkerSandbox, workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import * as state from "../src/brain/operational-state.js";
const evidence = state.operationalStateEvidence ?? {
  identity(path: string) { const info = fs.lstatSync(path); return { device: String(info.dev), inode: String(info.ino), owner: info.uid, mode: info.mode, type: "1" }; },
  mounts: () => fs.readFileSync("/proc/self/mountinfo", "utf8"),
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-state-proof-")); roots.push(root);
  const brainPath = join(root, "brain"), objects = join(root, "objects");
  fs.mkdirSync(brainPath); fs.mkdirSync(objects); fs.mkdirSync(join(objects, "nested"));
  fs.writeFileSync(join(objects, "nested/state"), "Odysseus");
  const input = { brainPath, privateStatePaths: [{ setting: "journal", path: objects }] };
  const record: state.OperationalStateProof[] = [];
  const proof = state.createOperationalStateProof?.(p => record.push(p)) ?? state.operationalStateRefusal;
  return { root, brainPath, objects, input, record, proof };
}
function boundary(f: ReturnType<typeof fixture>) {
  let topology = "1 0 0:1 / / rw - ext4 /dev/root rw\n";
  const realIdentity = evidence.identity;
  const identity = spyOn(evidence, "identity").mockImplementation(path => ({ ...realIdentity(path), device: path === f.brainPath ? "brain-subvolume" : "state-subvolume" }));
  const mounts = spyOn(evidence, "mounts").mockImplementation(() => topology);
  return { identity, mounts, topology(value: string) { topology = value; }, close() { identity.mockRestore(); mounts.mockRestore(); } };
}
test("a current distinct boundary reads no state directory after full qualification", () => {
  const f = fixture(), b = boundary(f); const read = spyOn(fs, "readdirSync");
  try {
    expect(f.proof(f.input)).toBeUndefined(); expect(read.mock.calls.length).toBeGreaterThan(0);
    read.mockClear(); b.mounts.mockClear();
    expect(f.proof(f.input)).toBeUndefined();
    expect(read.mock.calls.length, "NO_STATE_DIRECTORY_READ_ON_IDENTITY_PROOF").toBe(0);
    expect(b.mounts).toHaveBeenCalledTimes(1);
    expect(f.record.at(-1)?.mode).toBe("filesystem_identity");
  } finally { read.mockRestore(); b.close(); }
});
for (const change of ["identity", "state mount", "worker mount", "configuration", "read failure"] as const) test(`${change} requalifies instead of reusing a verdict`, () => {
  const f = fixture(), b = boundary(f); const read = spyOn(fs, "readdirSync");
  try {
    f.proof(f.input); read.mockClear();
    if (change === "identity") b.identity.mockImplementation(path => ({ device: "shared", inode: String(fs.lstatSync(path).ino), owner: process.geteuid!(), mode: 0o700, type: "1" }));
    if (change === "state mount") b.topology(`1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / ${f.objects}/nested rw - ext4 /dev/state rw\n`);
    if (change === "worker mount") b.topology(`1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / ${f.brainPath}/mounted rw - ext4 /dev/state rw\n`);
    if (change === "configuration") f.input.privateStatePaths[0]!.setting = "replacement journal";
    if (change === "read failure") b.identity.mockImplementation(() => { throw Error("EIO reading state boundary"); });
    f.proof(f.input);
    expect(read.mock.calls.length, "FULL_GUARD_REQUALIFIES_CHANGED_EVIDENCE").toBeGreaterThan(0);
    if (change === "read failure") expect(f.record.at(-1)).toMatchObject({ mode: "walk", cause: expect.stringContaining("EIO") });
  } finally { read.mockRestore(); b.close(); }
});
test("same-filesystem aliases are refused on every admission and recover when removed", () => {
  const f = fixture(); const alias = join(f.brainPath, "alias");
  expect(f.proof(f.input)).toBeUndefined();
  fs.linkSync(join(f.objects, "nested/state"), alias);
  expect(f.proof(f.input)?.detail).toContain("inode alias inside");
  fs.unlinkSync(alias); expect(f.proof(f.input)).toBeUndefined();
  expect(f.record.at(-1)?.mode).toBe("walk");
});

test("the owner status reports the current proof mode and cause", () => {
  const f = fixture();
  const boundary = createHostBoundary({ ...f.input, workerHost: () => ({ ok: true }) });
  expect(boundary.status().stateBoundary, "OWNER_CAN_SEE_STATE_PROOF_MODE").toMatchObject({ mode: "walk", cause: expect.any(String) });
});

for (const kind of ["directory", "database"] as const) test(`a dedicated state mount is a boundary, not a nested mount (${kind})`, () => {
  const f = fixture(), b = boundary(f);
  const input = kind === "directory" ? { ...f.input, privateStatePaths: [{ setting: "journal", path: f.objects }] }
    : { brainPath: f.brainPath, dbPath: join(f.objects, "ui.db"), privateStatePaths: [{ setting: "journal", path: join(f.objects, "nested") }] };
  if (kind === "database") fs.writeFileSync(input.dbPath!, "Odysseus database fixture");
  b.topology(`1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / ${f.objects} rw - ext4 /dev/state rw\n`);
  const read = spyOn(fs, "readdirSync");
  try {
    expect(f.proof(input)).toBeUndefined(); read.mockClear();
    expect(f.proof(input)).toBeUndefined();
    expect(read.mock.calls.length, "DEDICATED_STATE_MOUNT_USES_IDENTITY_PROOF").toBe(0);
  } finally { read.mockRestore(); b.close(); }
});
for (const failedIdentity of [false, true]) test(`a host-visible mount alias is refused and recovers (identity failure: ${failedIdentity})`, () => {
  const f = fixture(), other = fixture(), b = boundary(f);
  try {
    expect(f.proof(f.input)).toBeUndefined();
    b.topology(`1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:1 ${f.objects} /opt/odysseus-state-alias rw - ext4 /dev/root rw\n`);
    if (failedIdentity) b.identity.mockImplementation(() => { throw Error("Odysseus identity unavailable"); });
    expect(f.proof(f.input), "HOST_VISIBLE_ALIAS_CANNOT_PASS_BY_WALKING").toMatchObject({ available: false, detail: expect.stringContaining("worker-visible") });
    expect(other.proof(other.input), "ANOTHER_BRAIN_REMAINS_USABLE").toBeUndefined();
    b.topology("1 0 0:1 / / rw - ext4 /dev/root rw\n");
    expect(f.proof(f.input), "REMOVED_ALIAS_RECOVERS_AUTOMATICALLY").toBeUndefined();
  } finally { b.close(); }
});
for (const failedIdentity of [false, true]) test(`retargeted state refreshes the actual shared worker masks (identity failure: ${failedIdentity})`, () => {
  const f = fixture(), replacement = fs.mkdtempSync(join(tmpdir(), "odysseus-state-retarget-")); roots.push(replacement);
  const target = join(replacement, "objects"); fs.mkdirSync(target);
  const selected = join(f.root, "selected"); fs.symlinkSync(f.objects, selected);
  const input = { brainPath: f.brainPath, privateStatePaths: [{ setting: "journal", path: selected }] };
  const masks = state.operationalStateMasks(input), oldMasks = [...masks];
  const host = createHostBoundary({ ...input, workerMaskPaths: masks, workerHost: () => ({ ok: true }) });
  const failure = failedIdentity ? spyOn(evidence, "identity").mockImplementation(() => { throw Error("Odysseus identity read failed"); }) : undefined;
  try {
    host.status(); fs.unlinkSync(selected); fs.symlinkSync(target, selected); host.status();
    expect(host.maintenance?.maskPaths, "TURN_AND_MAINTENANCE_SHARE_REFRESHED_MASKS").toBe(masks);
    expect(masks, "RETARGETED_STATE_IS_ACTUALLY_MASKED").toContain(target);
    expect(masks).toContain(replacement);
    for (const old of oldMasks) expect(masks).toContain(old);
  } finally { failure?.mockRestore(); }
});

test("unsafe state aliases block every execution entry without a host fallback", async () => {
  const f = fixture(), b = boundary(f);
  const host = createHostBoundary({ ...f.input, workerHost: () => ({ ok: true }) });
  b.topology(`1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:1 ${f.objects} /opt/odysseus-state-alias rw - ext4 /dev/root rw\n`);
  let executed = false;
  const command = { argv: ["/bin/true"], env: {}, credentials: false, gate: "none" as const,
    purpose: "Odysseus boundary assertion", onExecute() { executed = true; } };
  try {
    expect(host.status()).toMatchObject({ available: false, reason: "private_state_in_brain", hostExecution: "worker" });
    await expect(host.prepare(), "UNSAFE_STATE_REFUSES_PREPARATION").rejects.toThrow("worker-visible");
    await expect(host.run(command), "UNSAFE_STATE_REFUSES_RUN").rejects.toThrow("worker-visible");
    const launched = host.launch(command).then(async value => {
      await Promise.all([new Response(value.stdout).text(), new Response(value.stderr).text(), value.exited]); await value.settled; return value;
    });
    await expect(launched, "UNSAFE_STATE_REFUSES_LAUNCH").rejects.toThrow("worker-visible");
    await expect(host.runSync({ ...command, timeoutMs: 1000 }), "UNSAFE_STATE_REFUSES_SYNC_READER").rejects.toThrow("worker-visible");
    expect(executed, "NO_EXECUTION_BEFORE_STATE_REFUSAL").toBe(false);
  } finally { b.close(); }
});

test("an existing worker mask list hides a retargeted secret in a real sandbox", () => {
  const root = fs.mkdtempSync("/var/tmp/odysseus-state-mask-"); roots.push(root);
  const brainPath = join(root, "brain"), config = join(root, "config"), selected = join(config, "selected");
  const old = join(root, "data/old/objects"), target = join(root, "data/new/objects");
  for (const path of [brainPath, config, old, target]) fs.mkdirSync(path, { recursive: true });
  fs.writeFileSync(join(target, "private"), "Odysseus private state"); fs.symlinkSync(old, selected);
  const input = { brainPath, privateStatePaths: [{ setting: "journal", path: selected }] }, masks = state.operationalStateMasks(input);
  const host = createHostBoundary({ ...input, workerMaskPaths: masks, workerHost: () => ({ ok: true }) });
  const read = () => {
    const sandbox = prepareWorkerSandbox(brainPath, { profile: "governed", areas: [], readPaths: ["/bin/sh", join(root, "data")], maskPaths: masks });
    const child = Bun.spawnSync(workerCommand({ brainPath, sandbox, env: {}, command: ["/bin/sh", "-c",
      'if test -r "$1/private"; then printf visible; else printf masked; fi', "probe", target] }), { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0); return child.stdout.toString();
  };
  fs.unlinkSync(selected); fs.symlinkSync(target, selected);
  expect(read(), "STALE_MASK_CONTROL_EXPOSES_NEW_TARGET").toBe("visible");
  host.status();
  expect(read(), "RETAINED_WORKER_MASKS_HIDE_RETARGETED_STATE").toBe("masked");
});
