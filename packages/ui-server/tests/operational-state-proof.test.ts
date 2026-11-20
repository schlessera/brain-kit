import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
for (const change of ["identity", "state mount", "worker mount", "host alias mount", "configuration", "read failure"] as const) test(`${change} requalifies instead of reusing a verdict`, () => {
  const f = fixture(), b = boundary(f); const read = spyOn(fs, "readdirSync");
  try {
    f.proof(f.input); read.mockClear();
    if (change === "identity") b.identity.mockImplementation(path => ({ device: "shared", inode: String(fs.lstatSync(path).ino), owner: process.geteuid!(), mode: 0o700, type: "1" }));
    if (change === "state mount") b.topology(`1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / ${f.objects}/nested rw - ext4 /dev/state rw\n`);
    if (change === "worker mount") b.topology(`1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / ${f.brainPath}/mounted rw - ext4 /dev/state rw\n`);
    if (change === "host alias mount") b.topology(`1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:1 ${f.objects} /opt/odysseus-state-alias rw - ext4 /dev/root rw\n`);
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
