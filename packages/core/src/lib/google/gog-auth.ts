/**
 * gog's account commands, which `brain google connect` and `status` run and
 * no model-facing path ever does (#4208, plan §10, "Connecting an account").
 *
 * They are not catalog operations, so they do not go through the transport's
 * `execute`; they keep its discipline instead: the pinned binary (verified by
 * the transport before every run, see `standalone.ts`), the allow-listed
 * environment, `--no-input --json --color=never`, exactly one command allowed
 * (`--enable-commands-exact`), `--gmail-no-send`, every value one
 * `--flag=value` element, positionals only after `--`, a body only on stdin,
 * stdout capped, a timeout and a process-group kill. Unlike a catalog
 * operation, `auth add` may show its stderr to the operator, who needs gog's
 * authorization URL and hints; nothing else here ever does.
 *
 * The flags are gog v0.48.1's (`internal/cmd/auth_add.go`, `auth_alias.go`,
 * `auth_accounts.go`, `auth_credentials.go`; root `--readonly` and `--force`,
 * `internal/cmd/root.go`). The pin admits only that release, so they exist
 * wherever these commands run. They are not in the schema snapshot, which
 * covers the catalog's commands, so the maintainer's disposable-account
 * proof (#4208) is what shows their shapes against a real gog.
 */
import type { GogEnvironment } from "@schlessera/brain-common/internal/google-gog";

/** The Gmail scopes brain-kit asks for, and gog's identity scopes, which every grant carries (`ScopesForManageWithOptions`). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GOG_IDENTITY_SCOPES: readonly string[] = Object.freeze(["email", "https://www.googleapis.com/auth/userinfo.email", "openid"]);

/** Exactly what a connect asks gog for: read-only, or with `--write` `gmail.readonly` and `gmail.modify` (plan §10). */
export function connectScopes(write: boolean): string[] {
  return [...GOG_IDENTITY_SCOPES, GMAIL_READONLY_SCOPE, ...(write ? [GMAIL_MODIFY_SCOPE] : [])].sort();
}

/** The account commands, by the dot path `--enable-commands-exact` takes. */
export const GOG_AUTH_COMMANDS = Object.freeze({
  "auth.add": ["auth", "add"],
  "auth.alias.set": ["auth", "alias", "set"],
  "auth.alias.list": ["auth", "alias", "list"],
  "auth.list": ["auth", "list"],
  "auth.remove": ["auth", "remove"],
  "auth.credentials.set": ["auth", "credentials", "set"],
} as const);
export type GogAuthCommand = keyof typeof GOG_AUTH_COMMANDS;

export interface GogAuthInvocation {
  command: GogAuthCommand;
  flags?: readonly (readonly [name: string, value: string | true])[];
  positionals?: readonly string[];
  /** Root `--readonly`: on `auth add` it asks for read-only scopes. */
  readonly?: boolean;
  /** Root `--force`: skips the confirmation `--no-input` would refuse (`auth remove`). */
  force?: boolean;
}

/** A refused argv value: the field is named, the value never is. */
export class GogAuthArgvError extends Error {
  constructor(readonly field: string) {
    super(`${field}: holds a control character or a line break`);
    this.name = "GogAuthArgvError";
  }
}

const NOT_ARGV = /[\p{Cc}\u2028\u2029]/u;
const value = (field: string, text: string) => {
  if (NOT_ARGV.test(text)) throw new GogAuthArgvError(field);
  return text;
};

/** The argv of one account command, gog's own path excluded. */
export function gogAuthArgv(call: GogAuthInvocation): string[] {
  const argv = ["--no-input", "--json", "--color=never", `--enable-commands-exact=${call.command}`];
  if (call.readonly) argv.push("--readonly");
  argv.push("--gmail-no-send");
  if (call.force) argv.push("--force");
  argv.push(...GOG_AUTH_COMMANDS[call.command]);
  for (const [name, flag] of call.flags ?? []) argv.push(flag === true ? `--${name}` : `--${name}=${value(name, flag)}`);
  const positionals = call.positionals ?? [];
  if (positionals.length > 0) argv.push("--", ...positionals.map(positional => value("positional", positional)));
  return argv;
}

/** How one account command ended. */
export type GogAuthEnd =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout" }
  | { kind: "signal" }
  | { kind: "output_too_large" }
  | { kind: "spawn_failed" };

export interface GogAuthRun {
  end: GogAuthEnd;
  /** stdout, only when the process exited. */
  stdout: Uint8Array | null;
}

export interface GogAuthRunOptions {
  env: GogEnvironment;
  stdin?: Uint8Array | null;
  timeoutMs: number;
  /** `inherit` shows gog's stderr to the operator; anything else drains and drops it. */
  stderr: "inherit" | "drop";
}

/** Account answers are small: an account list, an alias map, a URL. */
export const GOG_AUTH_STDOUT_CAP = 1024 * 1024;

function killGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
}

async function readCapped(stream: ReadableStream<Uint8Array>, cap: number, onOverflow: () => void): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  for await (const chunk of stream) {
    total += chunk.length;
    if (overflow) continue;
    if (total > cap) {
      overflow = true;
      chunks.length = 0;
      onOverflow();
      continue;
    }
    chunks.push(chunk);
  }
  return overflow ? null : Buffer.concat(chunks);
}

/**
 * Runs gog once in its own process group. An interrupt of this process kills
 * the group first, so an abandoned authorization leaves no gog listening.
 * Never throws for anything the process does.
 */
export async function runGogAuth(executable: string, argv: readonly string[], options: GogAuthRunOptions): Promise<GogAuthRun> {
  let proc: Bun.Subprocess<Uint8Array | "ignore", "pipe", "pipe" | "inherit">;
  try {
    proc = Bun.spawn([executable, ...argv], {
      env: { ...options.env },
      cwd: "/",
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: options.stderr === "inherit" ? "inherit" : "pipe",
      detached: true,
    });
  } catch {
    return { end: { kind: "spawn_failed" }, stdout: null };
  }
  let timedOut = false;
  let overflowed = false;
  const interrupted = () => killGroup(proc.pid);
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const timer = setTimeout(() => { timedOut = true; killGroup(proc.pid); }, options.timeoutMs);
  const stdout = readCapped(proc.stdout, GOG_AUTH_STDOUT_CAP, () => { overflowed = true; killGroup(proc.pid); });
  const stderr = typeof proc.stderr === "object" && proc.stderr ? (async () => { for await (const _ of proc.stderr as ReadableStream<Uint8Array>) { /* dropped */ } })() : Promise.resolve();
  const exitCode = await proc.exited;
  clearTimeout(timer);
  process.off("SIGINT", interrupted);
  process.off("SIGTERM", interrupted);
  killGroup(proc.pid);
  const [bytes] = await Promise.all([stdout, stderr]);
  if (overflowed) return { end: { kind: "output_too_large" }, stdout: null };
  if (timedOut) return { end: { kind: "timeout" }, stdout: null };
  if (proc.signalCode) return { end: { kind: "signal" }, stdout: null };
  return { end: { kind: "exit", exitCode }, stdout: bytes };
}
