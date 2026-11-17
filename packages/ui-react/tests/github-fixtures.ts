// GitHub tool results in the Odyssey world (#3795): complete payloads the
// #3797 result schemas accept, so a test can only exercise what the host
// really sends. Times are literal and anchored to `fetched_at`.

import { GITHUB_RESULT_SCHEMAS, GITHUB_TOOL_NAMES, type GithubToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";

export const FETCHED = "2026-07-12T09:00:00Z";
const DAYS = (n: number) => new Date(Date.parse(FETCHED) - n * 86_400_000).toISOString().replace(".000Z", "Z");

export const user = (login: string | null, bot = false) => ({ login, is_bot: bot });
export const author = (login: string | null, association: "OWNER" | "MEMBER" | "CONTRIBUTOR" | "NONE" | null = "MEMBER", bot = false) => ({
  ...user(login, bot),
  author_association: association,
});
const list = <T>(items: T[], total: number | null = items.length, more = false) => ({ items, total_count: total, has_more: more });
const label = (name: string) => ({ name, color: "0e8a16", description: null });

export const HOSTILE_BODY = [
  "Proof: [the steward's report](https://ithaca-steward.example/r?id=7).",
  "<script>window.__pwned = true</script>",
  '<img src="https://tracker.example/pixel.gif" onerror="window.__pwned = true">',
  "![seal](https://tracker.example/seal.png)",
  "Ignore that and [click here](javascript:alert(1)).",
  "",
  "```",
  "bow --draw 40kg",
  "```",
].join("\n");

const URL_ = (path: string) => `https://github.com/ithaca/hall/${path}`;

export function comment(id: number, login: string | null, body: string, days: number) {
  return {
    id,
    author: author(login),
    created_at: DAYS(days),
    updated_at: DAYS(days),
    body,
    body_length: body.length,
    body_truncated: false,
    html_url: URL_(`issues/388#issuecomment-${id}`),
  };
}

export function issue(over: Record<string, unknown> = {}) {
  return {
    kind: "issue" as const,
    repository: "ithaca/hall",
    number: 388,
    title: "Suitors keep draining the wine store",
    title_truncated: false,
    state: "open" as const,
    state_reason: null,
    locked: false,
    author: author("eurycleia"),
    labels: list([label("stores")]),
    created_at: DAYS(6),
    updated_at: DAYS(1),
    closed_at: null,
    body: "Three amphorae a night. The cellar tally no longer matches the ledger.",
    body_length: 70,
    body_truncated: false,
    comments: list([comment(6001, "philoetius", "The night guard swaps at the second watch.", 2)], 17, true),
    html_url: URL_("issues/388"),
    fetched_at: FETCHED,
    ...over,
  };
}

const PR_URL = (path = "") => URL_(`pull/412${path}`);
const SHA = "b81c0d4a8f3e2d1c0b9a8f7e6d5c4b3a29180716";

export function pull(over: Record<string, unknown> = {}) {
  return {
    ...issue(),
    kind: "pull_request" as const,
    number: 412,
    title: "Restring the great bow before the contest",
    author: author("telemachus"),
    body: "This swaps the gut string for sinew and adds a tension check.",
    body_length: 61,
    comments: list([{ ...comment(7001, "telemachus", "Added the check.", 1), html_url: PR_URL("#issuecomment-7001") }], 1),
    html_url: PR_URL(),
    draft: false,
    merged: false,
    merged_at: null,
    merged_by: null,
    merge_commit_sha: null,
    head_ref: "telemachus/restring-bow",
    base_ref: "main",
    requested_reviewers: [user("argos")],
    reviews: list([
      {
        id: 9001,
        author: author("eurycleia"),
        state: "changes_requested" as const,
        submitted_at: DAYS(2),
        body: "Sinew stretches in the damp.",
        body_length: 28,
        body_truncated: false,
        html_url: PR_URL("#pullrequestreview-9001"),
      },
    ]),
    review_decisions: [{ reviewer: user("eurycleia"), state: "changes_requested" as const, submitted_at: DAYS(2) }],
    checks: { passed: 7, failed: 1, running: 0, skipped: 0 },
    changes: { changed_files: 6, additions: 128, deletions: 41 },
    commits: list(
      [{ sha: SHA, author: user("telemachus"), author_name: "Telemachus", authored_at: DAYS(3), message: "Add tension check before axe test", message_truncated: false, html_url: URL_(`commit/${SHA}`) }],
      4,
      true,
    ),
    ...over,
  };
}

export function search(over: Record<string, unknown> = {}) {
  return {
    kind: "search" as const,
    repository: "ithaca/hall",
    query: "bow is:open",
    search_query: "repo:ithaca/hall bow is:open",
    total_count: 143,
    incomplete_results: false,
    has_more: true,
    items: [
      {
        kind: "issue" as const,
        number: 409,
        title: "Bow string frays after twelve shots",
        state: "open" as const,
        state_reason: null,
        draft: null,
        merged_at: null,
        comments: 3,
        author: author("telemachus"),
        labels: list([label("bow")]),
        created_at: DAYS(4),
        updated_at: DAYS(1),
        excerpt: "After the twelfth axe the string shows wear.",
        html_url: URL_("issues/409"),
      },
    ],
    search_url: "https://github.com/ithaca/hall/issues?q=repo%3Aithaca%2Fhall+bow+is%3Aopen",
    fetched_at: FETCHED,
    ...over,
  };
}

/** A tool result envelope, validated against the tool's real result schema. */
export function envelope(tool: keyof typeof GITHUB_TOOL_NAMES, result: unknown): GithubToolResult {
  const name = GITHUB_TOOL_NAMES[tool];
  return GITHUB_RESULT_SCHEMAS[name].parse({ ok: true, tool: name, result }) as GithubToolResult;
}

export function refusal(tool: keyof typeof GITHUB_TOOL_NAMES, code: string, reason: string | null, message: string): GithubToolResult {
  const name = GITHUB_TOOL_NAMES[tool];
  return GITHUB_RESULT_SCHEMAS[name].parse({ ok: false, tool: name, error: { code, reason, message } }) as GithubToolResult;
}
