/** Container root hands private diagnostics back to the outer proof-directory owner. */
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, openSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export function writePrivateProofArtifact(directory: string, name: string, bytes: Uint8Array | string): string {
  if (basename(name) !== name || name === "." || name === "..") throw Error("Invalid private proof artifact name");
  const owner = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = fstatSync(owner);
    const destination = join(directory, name);
    const fd = openSync(`/proc/self/fd/${owner}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, bytes);
      fchownSync(fd, identity.uid, identity.gid);
      fchmodSync(fd, 0o600);
      const result = fstatSync(fd);
      if (result.uid !== identity.uid || result.gid !== identity.gid || (result.mode & 0o7777) !== 0o600) throw Error("Private proof artifact ownership handoff failed");
    } finally { closeSync(fd); }
    return destination;
  } finally { closeSync(owner); }
}
