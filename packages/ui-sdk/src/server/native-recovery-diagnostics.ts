/** Host-private recovery causes, retained beside the authoritative native intents. */
import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function recordNativeRecoveryFailure(root: string, scope: string, site: string, error: unknown, log = true): boolean {
  const cause = { scope, site, at: Date.now(), errorClass: error instanceof Error ? error.name : "Error",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
  const name = createHash("sha256").update(`${site}:${scope}`).digest("hex");
  let diagnosticError: string | undefined;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const path = (suffix: string) => `/proc/self/fd/${directory}/${name}${suffix}`;
      const fd = openSync(path(".tmp"), constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(cause)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(path(".tmp"), path(".json")); fsyncSync(directory);
    } finally { closeSync(directory); }
  } catch (error) { diagnosticError = String(error); }
  if (log) console.error(JSON.stringify({ kind: "native_recovery_failure", ...cause, ...(diagnosticError ? { diagnosticError } : {}), diagnostics: join(root, `${name}.json`) }));
  return diagnosticError === undefined;
}
