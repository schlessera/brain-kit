/**
 * Whether a failed `/proc/<pid>/…` read means the process is gone. Opening
 * the path of an exited process fails with ENOENT; a file opened while the
 * process lived fails `read(2)` with ESRCH once it has been reaped
 * (`proc_pid_cmdline_read` and `proc_single_show` in Linux `fs/proc/base.c`).
 * Any other error is the caller's to throw.
 */
export const vanishedProcess = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH";
};
