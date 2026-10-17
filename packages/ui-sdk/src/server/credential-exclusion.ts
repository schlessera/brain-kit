/** Cross-process exclusion for host credential reads/refresh and credentialed maintenance. */
import { constants, closeSync, fstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export interface HostCredentialDomain {
  /** Trusted operational state, outside repository input. Tests supply their own private domain. */
  directory: string;
}
export class HostCredentialExclusionError extends Error {
  constructor(readonly reason: "busy" | "unavailable" | "cancelled") {
    super(`Host credential maintenance ${reason}.`);
    this.name = "HostCredentialExclusionError";
  }
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HostCredentialExclusionError("cancelled");
}

/**
 * Kernel flock belongs to an open-file description. The short trusted flock
 * process acquires it on inherited fd3; the server retains that same open-file
 * description until release. No shell, repository program, credential or host
 * environment enters the helper. Process exit closes the FD and releases the
 * lock without guessing about a stale PID or deleting another owner's file.
 */
export async function acquireHostCredentialExclusion(options: {
  domain?: HostCredentialDomain;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<{ release(): void }> {
  check(options.signal);
  const timeout = options.timeoutMs ?? 0;
  if (!Number.isFinite(timeout) || timeout < 0) throw new HostCredentialExclusionError("unavailable");
  let directory: number | undefined, fd: number | undefined;
  try {
    // Server and cron must agree even when their TMPDIR settings differ.
    const path = resolve(options.domain?.directory ?? join("/tmp", `brain-host-credentials-${process.getuid?.() ?? 0}`));
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (realpathSync(path) !== path) throw new HostCredentialExclusionError("unavailable");
    directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = fstatSync(directory);
    if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new HostCredentialExclusionError("unavailable");
    fd = openSync(`/proc/self/fd/${directory}/credentials.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o777) !== 0o600 || file.size !== 0) {
      throw new HostCredentialExclusionError("unavailable");
    }
    const flock = Bun.which("flock", { PATH: "/usr/bin:/bin" });
    if (!flock) throw new HostCredentialExclusionError("unavailable");
    const started = performance.now();
    for (;;) {
      check(options.signal);
      const result = Bun.spawnSync([flock, "--exclusive", "--nonblock", "3"], {
        cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe", fd], timeout: 5_000,
      });
      if (result.exitCode === 0) {
        check(options.signal);
        const held = fd;
        fd = undefined;
        let released = false;
        return { release() { if (!released) { released = true; closeSync(held); } } };
      }
      if (result.exitCode !== 1) throw new HostCredentialExclusionError("unavailable");
      const left = timeout - (performance.now() - started);
      if (left <= 0) throw new HostCredentialExclusionError("busy");
      await new Promise<void>((done, reject) => {
        const cancel = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); reject(new HostCredentialExclusionError("cancelled")); };
        const timer = setTimeout(() => { options.signal?.removeEventListener("abort", cancel); done(); }, Math.min(left, 25));
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) cancel();
      });
    }
  } catch (error) {
    if (error instanceof HostCredentialExclusionError) throw error;
    throw new HostCredentialExclusionError("unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (directory !== undefined) closeSync(directory);
  }
}
