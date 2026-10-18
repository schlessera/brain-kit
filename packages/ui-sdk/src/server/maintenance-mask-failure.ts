/** Fixed internal refusal observability; never serialize error messages or input. */
const phases = ["startup-view", "pre-abort", "pre-current", "context", "masks", "post-current", "post-abort", "generation", "post-context", "store"];
const classes = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "NativeBrainManagerError", "WorkerStateError", "WorkerIdentityCleanupError"];
const errnos = ["EACCES", "ENOENT", "ESTALE", "EBADF", "EINVAL", "EIO", "ELOOP", "ENOTDIR", "EPERM", "EINTR"];
/** A failed diagnostic must never change the original generic refusal. */
export function reportMaintenanceMaskFailure(phase: string, error: unknown, signal?: AbortSignal): void {
  try {
    const property = (key: "name" | "code") => {
      try { return error !== null && (typeof error === "object" || typeof error === "function") ? Reflect.get(error, key) : undefined; }
      catch { return undefined; }
    };
    const name = property("name"), code = property("code");
    let providedSignalAborted = false, errorIsProvidedAbortReason = false;
    try {
      providedSignalAborted = signal?.aborted === true;
      errorIsProvidedAbortReason = providedSignalAborted && error === signal?.reason;
    } catch { /* Diagnostic signal access is never refusal authority. */ }
    console.error(JSON.stringify({ nativeMaintenanceMaskFailure: {
      phase: phases.includes(phase) ? phase : "unknown",
      errorClass: typeof name === "string" && classes.includes(name) ? name : "unknown",
      errno: typeof code === "string" && errnos.includes(code) ? code : "unknown",
      providedSignalAborted, errorIsProvidedAbortReason,
    } }));
  } catch { /* Getter, proxy, serialization or stderr failures cannot replace the refusal. */ }
}
