import {
  GITHUB_DETAIL_ERROR_RESPONSE_SCHEMA, GITHUB_DETAIL_PAGE_SCHEMA, parseGithubRepository,
  type GithubDetailError, type GithubDetailPage, type GithubDetailPart,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import type { BrainUiServices } from "../root.js";

/** How long one detail request may take before it counts as no answer. */
const DETAIL_CALL_TIMEOUT_MS = 20_000;

interface GithubDetailRequest {
  sessionId: string;
  /** `owner/repo`, as the tool result named it. */
  repository: string;
  number: number;
  part: GithubDetailPart;
  /** The previous page's `next_cursor`; omitted for the first page. */
  cursor?: string | null;
  signal?: AbortSignal;
}

type GithubDetailResult = { ok: true; page: GithubDetailPage } | { ok: false; error: GithubDetailError };

const failed = (code: GithubDetailError["code"], reason: string | null, message: string): GithubDetailResult =>
  ({ ok: false, error: { code, reason, message, reset_at: null } });

/**
 * One page of a GitHub object's detail (#3796), for the chat's GitHub
 * components. Display data only: the host never adds it to the conversation.
 * Nothing is cached here; a component keeps what it loaded for its lifetime.
 * Every failure resolves to the host's typed error, or `upstream_error` when
 * the host did not answer with one.
 */
export async function fetchGithubDetailPage(root: Pick<BrainUiServices, "apiBase" | "request">, input: GithubDetailRequest): Promise<GithubDetailResult> {
  const repository = parseGithubRepository(input.repository);
  if (!repository || !Number.isSafeInteger(input.number) || input.number < 1) return failed("invalid_input", "object", "That is not a GitHub issue or pull request.");
  const path = [input.sessionId, "github", repository.owner, repository.repo, String(input.number), input.part].map(encodeURIComponent).join("/");
  const query = input.cursor ? `?${new URLSearchParams({ cursor: input.cursor })}` : "";
  const timeout = AbortSignal.timeout(DETAIL_CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await root.request(`${root.apiBase()}/sessions/${path}${query}`, { cache: "no-store",
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout });
  } catch {
    // The host's own failures carry a `host_` reason, so no card reads them as GitHub's.
    return failed("upstream_error", input.signal?.aborted ? "cancelled" : "host_no_answer", "The host did not answer.");
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const page = GITHUB_DETAIL_PAGE_SCHEMA.safeParse(json);
    if (page.success && page.data.part === input.part && page.data.number === input.number) return { ok: true, page: page.data };
    return failed("upstream_error", "host_malformed", "The host answered with something that is not a detail page.");
  }
  const error = GITHUB_DETAIL_ERROR_RESPONSE_SCHEMA.safeParse(json);
  if (error.success) return { ok: false, error: error.data.error };
  if (response.status === 401) return failed("unavailable", "authentication", "Sign in again to load more.");
  return failed("upstream_error", `host_http_${response.status}`, `The host could not load this (HTTP ${response.status}).`);
}

/**
 * The same-origin URL of a GitHub user's avatar in this session (#3796). The
 * browser never contacts GitHub; any failure is a 404, so a component falls
 * back to initials.
 */
export function githubAvatarUrl(apiBase: string, sessionId: string, login: string, size = 64): string {
  return `${apiBase}/sessions/${encodeURIComponent(sessionId)}/github/avatars/${encodeURIComponent(login)}?size=${Math.max(1, Math.min(9999, Math.round(size)))}`;
}
