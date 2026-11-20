import { afterEach, expect, spyOn, test } from "bun:test";
import { fstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kernel from "../src/brain/reference-owner-root-kernel";
import { createReferenceOwnerContinuity } from "../src/brain/reference-owner-native-root";
const expected = { fsid: "11111111-1111-4111-8111-111111111790", brainUuid: "11".repeat(16) };
const identity = { fsid: expected.fsid, uuid: expected.brainUuid, readOnly: false, receivedUuid: "0".repeat(32), devices: 1 };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function root() { const path = mkdtempSync(join(tmpdir(), "odysseus-owner-native-")); cleanup.push(() => rmSync(path, { recursive: true, force: true })); return path; }

for (const field of ["fsid", "uuid", "readOnly", "receivedUuid", "devices"] as const) test(`actual pinned-root identity refuses mismatched ${field}`, async () => {
  const path = root(); let fd = -1;
  const wrong = { ...identity, [field]: field === "readOnly" ? true : field === "devices" ? 2 : "22".repeat(16) };
  const spy = spyOn(kernel, "inspectPinnedReferenceRoot").mockImplementation(async value => { fd = value; return wrong; }); cleanup.push(() => spy.mockRestore());
  const context = await createReferenceOwnerContinuity(path, expected); cleanup.push(() => context.close());
  expect(context.root, "ONLY_QUALIFIED_NATIVE_ROOT_CAN_BIND_APPROVAL").toBeUndefined();
  expect(() => fstatSync(fd), "REFUSED_NATIVE_ROOT_DESCRIPTOR_IS_CLOSED").toThrow();
});

test("startup attests the already held descriptor and refuses replacement during the inspection wait", async () => {
  const path = root(), previous = path + "-previous"; cleanup.push(() => rmSync(previous, { recursive: true, force: true }));
  let fd = -1;
  const spy = spyOn(kernel, "inspectPinnedReferenceRoot").mockImplementation(async value => {
    fd = value; const held = fstatSync(value); renameSync(path, previous); mkdirSync(path);
    expect(readlinkSync(`/proc/self/fd/${value}`), "NATIVE_ATTESTATION_INSPECTS_ORIGINAL_PINNED_ROOT").toBe(previous);
    expect(fstatSync(value).ino).toBe(held.ino);
    return identity;
  }); cleanup.push(() => spy.mockRestore());
  const context = await createReferenceOwnerContinuity(path, expected); cleanup.push(() => context.close());
  expect(context.root, "STARTUP_REPLACEMENT_NEVER_ADOPTS_QUALIFIED_ROOT").toBeUndefined();
  expect(() => fstatSync(fd)).toThrow();
});

test("unsupported real filesystem withholds qualification without a native stand-in", async () => {
  // This fixture is an ordinary temporary directory, never a Btrfs subvolume.
  const context = await createReferenceOwnerContinuity(root(), expected); cleanup.push(() => context.close());
  expect(context.root, "ORDINARY_DIRECTORY_IS_NOT_NATIVE_QUALIFICATION").toBeUndefined();
});
