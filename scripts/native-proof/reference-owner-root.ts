/** Actual Btrfs deletion/recreation at one path; no kernel identity stand-in. */
import { expect } from "bun:test";
import { openSync, closeSync, constants, fstatSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspectPinnedReferenceRoot } from "../../packages/ui-server/src/brain/reference-owner-root-kernel.js";
import { createReferenceOwnerContinuity } from "../../packages/ui-server/src/brain/reference-owner-native-root.js";
export async function proveReferenceOwnerRoot(brain: string, note: (kind: string, facts: Record<string, unknown>) => void) {
  const path = join(dirname(brain), "odysseus-owner-recreated"), policy = "---\nschema_version: 1\n---\nThe voyage policy.\n";
  const btrfs = (...args: string[]) => { const p = Bun.spawnSync(["/usr/bin/btrfs", ...args], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode, `OWNER_NATIVE_BTRFS: ${p.stderr}`).toBe(0); };
  let exists = false;
  const inspect = async () => { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { return { identity: await inspectPinnedReferenceRoot(fd), inode: fstatSync(fd).ino }; } finally { closeSync(fd); } };
  try {
    btrfs("subvolume", "create", path); exists = true; writeFileSync(join(path, "governance.md"), policy);
    const original = await inspect(), expected = { fsid: original.identity.fsid, brainUuid: original.identity.uuid };
    const first = await createReferenceOwnerContinuity(path, expected);
    try { expect(first.root, "NATIVE_ORIGINAL_ROOT_QUALIFIES").toBeDefined(); } finally { first.close(); }
    const restart = await createReferenceOwnerContinuity(path, expected);
    try { expect(restart.root?.native, "NATIVE_ORDINARY_RESTART_PRESERVES_IDENTITY").toEqual(first.root!.native); } finally { restart.close(); }
    rmSync(join(path, "governance.md")); btrfs("subvolume", "delete", path); exists = false;
    btrfs("subvolume", "create", path); exists = true; writeFileSync(join(path, "governance.md"), policy);
    const replacement = await inspect();
    expect(replacement.inode, "NATIVE_REPLACEMENT_REUSES_SUBVOLUME_ROOT_INODE").toBe(original.inode);
    expect(replacement.identity.fsid).toBe(original.identity.fsid);
    expect(replacement.identity.uuid).not.toBe(original.identity.uuid);
    expect(readFileSync(join(path, "governance.md"), "utf8")).toBe(policy);
    const refused = await createReferenceOwnerContinuity(path, expected);
    try { expect(refused.root, "NATIVE_RECREATED_ROOT_CANNOT_INHERIT_APPROVAL").toBeUndefined(); } finally { refused.close(); }
    note("managed-source-owner-native-root-recreation", { original: original.identity, replacement: replacement.identity,
      originalInode: original.inode, replacementInode: replacement.inode, samePolicyBytes: true, restartQualified: true, replacementRefused: true });
  } finally { if (exists) { rmSync(join(path, "governance.md"), { force: true }); btrfs("subvolume", "delete", path); } }
}
