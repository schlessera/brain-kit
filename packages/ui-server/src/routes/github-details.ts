import { Hono, type Context } from "hono";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { isGithubDetailPart, isGithubRepositoryName, type GithubDetailError, type GithubErrorCode } from "@schlessera/brain-ui-sdk/tool-contracts";

import type { AppEnv } from "../app-env.js";
import type { Principal } from "../db/principals.js";
import { GithubDetailInputError, githubSessionScope, type GithubDetails } from "../github/details.js";
import { GithubRefusal, LOGIN } from "../github/host.js";

export interface GithubDetailRouteDeps {
  details: GithubDetails;
  principalValid: (principal: Principal) => boolean;
  /** Whether the caller is the chat's owner account (any of its logins). */
  owns: (principal: Principal, sessionId: string) => boolean;
  /** Whether the chat is retired (#3230): it has nothing left to show. */
  retired: (sessionId: string) => boolean;
  /** The session's recorded history, as its owning backend replays it. */
  history: (sessionId: string) => Promise<SessionHistoryMessage[]>;
  /** Settles once catalog writes submitted before it have committed. */
  settled?: () => Promise<void>;
}

const SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const STATUS: Partial<Record<GithubErrorCode, 400 | 403 | 404 | 429 | 502 | 503>> = {
  invalid_input: 400, forbidden: 403, not_found: 404, rate_limited: 429, unavailable: 503, upstream_error: 502,
};

function refuse(c: Context<AppEnv>, code: GithubErrorCode, reason: string | null, message: string, resetAt: string | null = null) {
  const error: GithubDetailError = { code, reason, message, reset_at: resetAt };
  if (code === "rate_limited" && resetAt) c.header("Retry-After", String(Math.max(0, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000))));
  return c.json({ error }, STATUS[code] ?? 502);
}

/**
 * The on-demand GitHub detail pages and the avatar proxy (#3796), internal
 * routes for the chat components. Owner-authenticated, read-only and never
 * provider context: a response is not added to the conversation, not
 * journaled as turn input, and does not taint the session.
 *
 * - `GET /sessions/:id/github/:owner/:repo/:number/:part?cursor=` pages one
 *   part of an object a GitHub tool result in that session returned.
 * - `GET /sessions/:id/github/avatars/:login?size=` serves the avatar of a
 *   login in those results from this origin; every failure is a bare 404.
 */
export function createGithubDetailRoutes(deps: GithubDetailRouteDeps): Hono<AppEnv> {
  /** Authentication, then ownership, then the chat's recorded scope; null when it may be read. */
  async function admit(c: Context<AppEnv>, sessionId: string) {
    const principal = c.get("principal");
    if (!principal || !deps.principalValid(principal)) return { refusal: c.json({ error: "Authentication required", authRequired: true }, 401) };
    if (!SESSION_ID.test(sessionId)) return { refusal: refuse(c, "invalid_input", "session", "That is not a session id.") };
    await deps.settled?.();
    if (!deps.owns(principal, sessionId)) return { refusal: refuse(c, "forbidden", "not_owner", "Only the chat's owner can read its GitHub details.") };
    if (deps.retired(sessionId)) return { refusal: refuse(c, "not_found", "not_in_session", "This host has no such session.") };
    let history: SessionHistoryMessage[];
    try { history = await deps.history(sessionId); }
    catch { return { refusal: refuse(c, "not_found", "not_in_session", "This session's history could not be read.") }; }
    if (!deps.principalValid(principal)) return { refusal: c.json({ error: "Authentication required", authRequired: true }, 401) };
    return { refusal: null, principal, scope: githubSessionScope(history) };
  }

  return new Hono<AppEnv>()
    .get("/sessions/:id/github/avatars/:login", async (c) => {
      const notFound = () => { c.header("Cache-Control", "no-store"); return c.body(null, 404); };
      const sessionId = c.req.param("id"), login = c.req.param("login");
      const rawSize = c.req.query("size") ?? "64";
      if (!LOGIN.test(login) || !/^[1-9][0-9]{0,3}$/.test(rawSize)) return notFound();
      const admitted = await admit(c, sessionId);
      if (admitted.refusal) return admitted.refusal.status === 401 ? admitted.refusal : notFound();
      const lower = login.toLowerCase();
      if (!admitted.scope.logins.has(lower) && !deps.details.servedLogin(sessionId, lower)) return notFound();
      const image = await deps.details.avatar(login, Number(rawSize), c.req.raw.signal);
      if (!image || !deps.principalValid(admitted.principal)) return notFound();
      return new Response(image.bytes, { status: 200, headers: {
        "Content-Type": image.type, "Content-Length": String(image.bytes.byteLength), "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=3600",
      } });
    })
    .get("/sessions/:id/github/:owner/:repo/:number/:part", async (c) => {
      c.header("Cache-Control", "no-store");
      const sessionId = c.req.param("id"), owner = c.req.param("owner"), repo = c.req.param("repo");
      const rawNumber = c.req.param("number"), part = c.req.param("part"), cursor = c.req.query("cursor") ?? null;
      if (!isGithubDetailPart(part)) return refuse(c, "invalid_input", "part", "That part is not one of comments, reviews, review-comments, commits, files or checks.");
      if (!isGithubRepositoryName(owner, repo) || !/^[1-9][0-9]{0,9}$/.test(rawNumber) || Number(rawNumber) > 2_147_483_647)
        return refuse(c, "invalid_input", "object", "That is not a GitHub issue or pull request.");
      if (cursor !== null && cursor.length > 64) return refuse(c, "invalid_input", "cursor", "The cursor is not one this host issued.");
      const admitted = await admit(c, sessionId);
      if (admitted.refusal) return admitted.refusal;
      // Bounded authority: only an object this session's GitHub results returned.
      const object = admitted.scope.objects.get(`${owner.toLowerCase()}/${repo.toLowerCase()}#${Number(rawNumber)}`);
      if (!object) return refuse(c, "not_found", "not_in_session", "No GitHub result in this session returned that issue or pull request.");
      try {
        const page = await deps.details.page(sessionId, object, part, cursor, c.req.raw.signal);
        if (!deps.principalValid(admitted.principal)) return c.json({ error: "Authentication required", authRequired: true }, 401);
        return c.json(page);
      } catch (error) {
        if (error instanceof GithubDetailInputError)
          return error.reason === "not_pull_request" ? refuse(c, "not_found", error.reason, error.message) : refuse(c, "invalid_input", error.reason, error.message);
        if (error instanceof GithubRefusal) return refuse(c, error.code, error.reason ?? "github", error.message, error.resetAt);
        return refuse(c, "upstream_error", null, "The GitHub read failed.");
      }
    });
}
