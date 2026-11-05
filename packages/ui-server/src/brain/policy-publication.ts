/** Shared descriptor-bound privileged file publisher. Callers own the brain lock,
 * observation window and durable operation/turn identity. Never exported to workers. */
import { closeSync, constants, fchmodSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { verifyGovernancePolicyAnchored, type AnchoredGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";

export function publishProtectedPolicy(target: AnchoredGovernancePolicy, bytes: Uint8Array, baseHash: string | null,
  check: () => void, published: () => void): void {
  let temp: string | undefined;
  try {
    check(); verifyGovernancePolicyAnchored(target, baseHash);
    const staging = `/proc/self/fd/${target.directories.at(-1)!.fd}/.brain-policy-${crypto.randomUUID()}`;
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, target.mode ?? 0o644);
    temp = staging;
    try { writeFileSync(fd, bytes); if (target.mode !== undefined) fchmodSync(fd, target.mode); fsyncSync(fd); }
    finally { closeSync(fd); }
    // No await between the last authority/topology/base check and the atomic publication.
    check(); verifyGovernancePolicyAnchored(target, baseHash);
    if (baseHash === null) linkSync(temp, target.at); else renameSync(temp, target.at);
    published();
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    temp = undefined;
    // Include newly created ancestors: a durable name in the leaf alone does
    // not make its parent names durable after a power loss.
    for (const directory of [...target.directories].reverse()) fsyncSync(directory.fd);
  } finally { if (temp) { try { unlinkSync(temp); } catch { /* Only our staging name. */ } } }
}
