/**
 * The private relay socket directory (#4764): a fresh server-owned directory
 * outside the brain holding a server-owned Unix socket, bind-mounted into a
 * worker sandbox. Mode `0o700` and `0o600`, or `0o750` and `0o660` with the
 * server's group when workers run under a separate identity.
 *
 * The create half is what every relay runs; the verify half is what the
 * launcher checks before it mounts the directory. Both take "separate
 * identity" as an argument, so each branch can be tested without the identity
 * helper installed. A leaf: it imports neither the launcher nor the sandbox.
 */
import { chmodSync, chownSync, lstatSync, mkdtempSync, realpathSync, rmSync, type Stats } from "node:fs";
import { join, normalize } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";

const directoryMode = (separateIdentity: boolean) => separateIdentity ? 0o750 : 0o700;
const socketMode = (separateIdentity: boolean) => separateIdentity ? 0o660 : 0o600;
const holds = (dir: string, path: string) => isWithin(dir, path, { trailingSeparator: "boundary" });

/**
 * Make the directory (`mkdtemp` with `prefix`, a path prefix), owned by the
 * server user and group under a separate identity, with its private mode.
 * The directory is removed when any step fails.
 */
export function createPrivateSocketDirectory(prefix: string, separateIdentity: boolean): string {
  const dir = mkdtempSync(prefix);
  try {
    if (separateIdentity) chownSync(dir, process.getuid!(), process.getgid!());
    chmodSync(dir, directoryMode(separateIdentity));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/**
 * After the caller has bound `socketPath` inside `dir`: set the socket's owner
 * and mode the same way. The directory is removed when a step fails; the
 * caller stops its listener.
 */
export function securePrivateSocket(dir: string, socketPath: string, separateIdentity: boolean): void {
  try {
    if (separateIdentity) chownSync(socketPath, process.getuid!(), process.getgid!());
    chmodSync(socketPath, socketMode(separateIdentity));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Whether one socket is server-owned with its private mode, and the server's group under a separate identity. */
export function conformingPrivateSocket(info: Stats, separateIdentity: boolean): boolean {
  return info.isSocket() && info.uid === process.getuid?.()
    && (info.mode & 0o7777) === socketMode(separateIdentity)
    && (!separateIdentity || info.gid === process.getgid?.());
}

/**
 * The verify half: the real path of `requested` when it is exactly that path
 * (not reached through a link), a server-owned directory with its private mode
 * holding a conforming socket named `socket`, and neither inside nor around
 * `brain`. `undefined` for any other layout, including a missing or
 * unreadable one.
 */
export function verifyPrivateSocketDirectory(requested: string, socket: string, brain: string, separateIdentity: boolean): string | undefined {
  try {
    const directory = realpathSync(requested);
    const info = lstatSync(directory);
    if (directory === normalize(requested) && info.isDirectory() && info.uid === process.getuid?.()
      && (info.mode & 0o7777) === directoryMode(separateIdentity)
      && (!separateIdentity || info.gid === process.getgid?.())
      && conformingPrivateSocket(lstatSync(join(directory, socket)), separateIdentity)
      && !holds(brain, directory) && !holds(directory, brain)) return directory;
  } catch { /* Missing, aliased or unreadable IPC is never launch authority. */ }
  return undefined;
}
