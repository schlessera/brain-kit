/**
 * The GitHub detail client (#3796): one request per call to the host's
 * internal route, the page or the host's typed error back, and a
 * same-origin avatar URL. No caching and no GitHub origin anywhere.
 */
import { describe, expect, test } from "bun:test";
import type { GithubDetailPage } from "@schlessera/brain-ui-sdk/tool-contracts";
import { fetchGithubDetailPage, githubAvatarUrl } from "../src/lib/github-details.js";

const page: GithubDetailPage = { kind: "detail_page", repository: "odysseus/ithaca", number: 8, part: "files", total_count: null, next_cursor: "2",
  fetched_at: "2026-07-12T12:00:00.000Z", items: [{ filename: "bow/string.ts", previous_filename: null, status: "modified", additions: 3, deletions: 1, changes: 4 }] };

function root(answer: () => Response) {
  const urls: string[] = [];
  return { urls, root: { apiBase: () => "/api", request: async (url: string) => { urls.push(url); return answer(); } } };
}

describe("fetchGithubDetailPage", () => {
  test("asks the host's route for one part and returns the parsed page; each call asks again", async () => {
    const t = root(() => Response.json(page));
    const input = { sessionId: "sess ithaca", repository: "odysseus/ithaca", number: 8, part: "files" as const, cursor: "2" };
    expect(await fetchGithubDetailPage(t.root, input), "GITHUB_CLIENT_PAGE").toEqual({ ok: true, page });
    await fetchGithubDetailPage(t.root, { ...input, cursor: null });
    expect(t.urls, "GITHUB_CLIENT_NO_CACHE").toEqual(["/api/sessions/sess%20ithaca/github/odysseus/ithaca/8/files?cursor=2", "/api/sessions/sess%20ithaca/github/odysseus/ithaca/8/files"]);
  });

  test("returns the host's typed error, and a non-answer as upstream_error", async () => {
    const limited = { code: "rate_limited" as const, reason: "github", message: "Spent.", reset_at: "2026-07-12T12:10:00.000Z" };
    expect(await fetchGithubDetailPage(root(() => Response.json({ error: limited }, { status: 429 })).root,
      { sessionId: "s", repository: "odysseus/ithaca", number: 7, part: "comments" }), "GITHUB_CLIENT_TYPED_ERROR").toEqual({ ok: false, error: limited });
    const garbled = await fetchGithubDetailPage(root(() => new Response("<html>", { status: 200 })).root, { sessionId: "s", repository: "odysseus/ithaca", number: 7, part: "comments" });
    expect(garbled).toMatchObject({ ok: false, error: { code: "upstream_error", reason: "host_malformed" } });
    const proxied = await fetchGithubDetailPage(root(() => new Response("<html>", { status: 504 })).root, { sessionId: "s", repository: "odysseus/ithaca", number: 7, part: "comments" });
    expect(proxied, "the host's own status is never GitHub's").toMatchObject({ ok: false, error: { code: "upstream_error", reason: "host_http_504" } });
    const silent = await fetchGithubDetailPage({ apiBase: () => "/api", request: async () => { throw new TypeError("offline"); } }, { sessionId: "s", repository: "odysseus/ithaca", number: 7, part: "comments" });
    expect(silent).toMatchObject({ ok: false, error: { code: "upstream_error", reason: "host_no_answer" } });
    const refused = root(() => Response.json(page));
    expect(await fetchGithubDetailPage(refused.root, { sessionId: "s", repository: "../ithaca", number: 7, part: "comments" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(refused.urls, "GITHUB_CLIENT_INVALID_SENDS_NOTHING").toEqual([]);
  });
});

test("githubAvatarUrl is same-origin and encodes the login", () => {
  expect(githubAvatarUrl("/api", "sess-ithaca", "herald[bot]", 40)).toBe("/api/sessions/sess-ithaca/github/avatars/herald%5Bbot%5D?size=40");
});
