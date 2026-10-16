/**
 * Server-only stored-login resolver, qualified against CLI 2.1.293 (#1665).
 * Not connected to ordinary workers until their credential-free relay is qualified.
 * Callers supply the trusted host config directory, never a request-selected path.
 */
import { constants, closeSync, fstatSync, fsyncSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireHostCredentialExclusion, HostCredentialExclusionError, type HostCredentialDomain } from "@schlessera/brain-ui-sdk/internal";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const LIMIT = 64 * 1024;
const MARGIN = 300_000;

type Json = Record<string, unknown>;
interface Login extends Json {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  clientId?: string;
}

/** Fixed messages only: upstream replies and filesystem errors may contain secrets. */
export class ClaudeHostAuthError extends Error {
  constructor(readonly reason: "unavailable" | "invalid" | "busy" | "changed" | "refresh" | "cancelled") {
    super(`Host Claude authentication ${reason}.`);
    this.name = "ClaudeHostAuthError";
  }
}

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= LIMIT && !/[\s\x00-\x1f\x7f]/.test(value);
}
function login(value: unknown): Login {
  if (!object(value) || !token(value.accessToken) || !Number.isFinite(value.expiresAt)
    || !Array.isArray(value.scopes) || !value.scopes.every(token) || !value.scopes.includes("user:inference")
    || (value.refreshToken !== undefined && !token(value.refreshToken))
    || (value.clientId !== undefined && !token(value.clientId))
    || (value.refreshTokenExpiresAt !== undefined && !Number.isFinite(value.refreshTokenExpiresAt))) {
    throw new ClaudeHostAuthError("invalid");
  }
  return value as Login;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ClaudeHostAuthError("cancelled");
}

/** Host-only result. Deliberately excludes refresh tokens and unknown store fields. */
export interface ClaudeHostOAuth {
  authorization: string;
  source: "environment" | "stored-login";
  subscriptionType?: string;
  rateLimitTier?: string;
}
function credential(value: Login): ClaudeHostOAuth {
  return { authorization: `Bearer ${value.accessToken}`, source: "stored-login",
    ...(typeof value.subscriptionType === "string" ? { subscriptionType: value.subscriptionType } : {}),
    ...(typeof value.rateLimitTier === "string" ? { rateLimitTier: value.rateLimitTier } : {}) };
}

/**
 * Reads current bytes on every request; neither startup tokens nor refresh results
 * are cached. Kernel-backed exclusion serializes host credential operations.
 * Observed native login/logout changes refuse publication. Native commands must
 * share the caller's credential-maintenance exclusion: this private lock cannot
 * serialize an independently launched native CLI. The kernel releases the
 * held descriptor on process exit; no stale owner is inferred or removed.
 */
export async function resolveClaudeHostOAuth(configDirectory: string,
  environment: Readonly<Record<string, string | undefined>>, signal?: AbortSignal,
  credentialDomain?: HostCredentialDomain): Promise<ClaudeHostOAuth> {
  cancelled(signal);
  // This measured protocol is production Claude OAuth only. Never send a
  // configured alternate authority's refresh token to the production endpoint.
  if (environment.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    throw new ClaudeHostAuthError("unavailable");
  }
  const supplied = environment.CLAUDE_CODE_OAUTH_TOKEN;
  if (supplied) {
    if (!token(supplied)) throw new ClaudeHostAuthError("invalid");
    return { authorization: `Bearer ${supplied}`, source: "environment" };
  }
  let directory: number | undefined;
  let exclusion: Awaited<ReturnType<typeof acquireHostCredentialExclusion>> | undefined;
  let staged: string | undefined;
  let base = "";
  try {
    exclusion = await acquireHostCredentialExclusion({ domain: credentialDomain, signal });
    const canonical = resolve(configDirectory);
    if (realpathSync(canonical) !== canonical) throw new ClaudeHostAuthError("invalid");
    directory = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = fstatSync(directory);
    if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new ClaudeHostAuthError("invalid");
    // Hold the directory, so a renamed ancestor cannot redirect publication.
    base = `/proc/self/fd/${directory}`;
    const read = (): { bytes: Buffer; record: Json; auth: Login } => {
      const fd = openSync(`${base}/.credentials.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > LIMIT) {
          throw new ClaudeHostAuthError("invalid");
        }
        // File size may grow after fstat. Allocate a fixed bound and read one
        // sentinel byte past it; never ask readFileSync to allocate from EOF.
        const buffer = Buffer.alloc(LIMIT + 1);
        let used = 0;
        while (used < buffer.length) {
          const count = readSync(fd, buffer, used, buffer.length - used, null);
          if (count === 0) break;
          used += count;
        }
        if (used > LIMIT) throw new ClaudeHostAuthError("invalid");
        const bytes = buffer.subarray(0, used);
        const record: unknown = JSON.parse(bytes.toString("utf8"));
        if (!object(record)) throw new ClaudeHostAuthError("invalid");
        return { bytes, record, auth: login(record.claudeAiOauth) };
      } finally { closeSync(fd); }
    };
    const initial = read();
    if (initial.auth.expiresAt > Date.now() + MARGIN) return credential(initial.auth);
    cancelled(signal);
    // Re-read under the lock: another resolver may have finished meanwhile.
    const current = read();
    const auth = current.auth;
    if (auth.expiresAt > Date.now() + MARGIN) return credential(auth);
    if (!auth.refreshToken || (auth.refreshTokenExpiresAt !== undefined && auth.refreshTokenExpiresAt <= Date.now())) {
      throw new ClaudeHostAuthError("unavailable");
    }
    const clientId = auth.clientId ?? environment.CLAUDE_CODE_OAUTH_CLIENT_ID ?? CLIENT_ID;
    if (!token(clientId)) throw new ClaudeHostAuthError("invalid");
    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, { method: "POST", redirect: "manual", signal: requestSignal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token",
          refresh_token: auth.refreshToken, client_id: clientId, scope: auth.scopes.join(" ") }) });
      if (response.status !== 200) { await response.body?.cancel(); throw new ClaudeHostAuthError("refresh"); }
      const reader = response.body?.getReader();
      if (!reader) throw new ClaudeHostAuthError("refresh");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > LIMIT) throw new ClaudeHostAuthError("refresh");
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!object(value) || !token(value.access_token) || !Number.isFinite(value.expires_in) || Number(value.expires_in) <= MARGIN / 1000
        || typeof value.scope !== "string" || (value.refresh_token !== undefined && !token(value.refresh_token))
        || (value.refresh_token_expires_in !== undefined && (!Number.isFinite(value.refresh_token_expires_in) || Number(value.refresh_token_expires_in) <= 0))) {
        throw new ClaudeHostAuthError("refresh");
      }
      const updated = login({ ...auth, accessToken: value.access_token, refreshToken: value.refresh_token ?? auth.refreshToken,
        expiresAt: Date.now() + Number(value.expires_in) * 1000, scopes: value.scope.split(" ").filter(Boolean),
        refreshTokenExpiresAt: value.refresh_token_expires_in !== undefined ? Date.now() + Number(value.refresh_token_expires_in) * 1000 : undefined });
      cancelled(signal);
      if (!read().bytes.equals(current.bytes)) throw new ClaudeHostAuthError("changed");
      const bytes = Buffer.from(JSON.stringify({ ...current.record, claudeAiOauth: updated }));
      if (bytes.length > LIMIT) throw new ClaudeHostAuthError("invalid");
      const candidate = `${base}/.brain-oauth-${randomUUID()}.tmp`;
      const fd = openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      staged = candidate;
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      // No await separates the comparison, atomic rename and directory fsync.
      if (!read().bytes.equals(current.bytes)) throw new ClaudeHostAuthError("changed");
      renameSync(staged, `${base}/.credentials.json`);
      staged = undefined;
      fsyncSync(directory);
      return credential(updated);
    } catch (error) {
      cancelled(signal);
      if (error instanceof ClaudeHostAuthError) throw error;
      throw new ClaudeHostAuthError("refresh");
    }
  } catch (error) {
    if (error instanceof ClaudeHostAuthError) throw error;
    if (error instanceof HostCredentialExclusionError) throw new ClaudeHostAuthError(error.reason);
    throw new ClaudeHostAuthError("unavailable");
  } finally {
    if (staged) { try { unlinkSync(staged); } catch { /* Never expose a private path. */ } }
    if (directory !== undefined) closeSync(directory);
    exclusion?.release();
  }
}
