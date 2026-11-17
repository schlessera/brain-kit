// The host GitHub tools' results as the ui-kit GitHub components (#3795):
// every spelling on every backend, the fallback, honest absent states, direct
// links only after #3797's validator, untrusted bodies end to end, and the
// write views W1–W4. Props-only, keyless, mounted in happy-dom.
import { registerGithubToolsDom, unregisterGithubToolsDom } from "./github-tools-dom.js";

registerGithubToolsDom();

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render as mount, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { visibleToolName, type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { GITHUB_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { resetToolRenderers, resolveToolRenderer } from "../../../ui-sdk/src/client/renderers.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { ToolPermissionCard } from "../../src/components/chat/tool-permission-card.js";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { HOSTILE_BODY, author, envelope, issue, pull, refusal, search } from "../github-fixtures.js";

const roots: ReturnType<typeof createBrainUiRoot>[] = [];
const requested: string[] = [];
afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const root of roots.splice(0)) root.dispose();
  });
  requested.length = 0;
  answer = () => new Response("{}", { status: 404 });
});
afterAll(async () => {
  await act(async () => cleanup());
  resetToolRenderers();
  await unregisterGithubToolsDom();
});

/** What the next detail-route call answers; the default is a 404 with no body. */
let answer: (url: string) => Response = () => new Response("{}", { status: 404 });

function render(ui: ReactElement) {
  const root = createBrainUiRoot({
    storage: null,
    request: async (url) => {
      requested.push(String(url));
      return answer(String(url));
    },
  });
  roots.push(root);
  // A session, so avatars and detail pages are possible: a test that finds
  // neither has proved the card did not ask, not that it could not.
  root.stores.chat.setState({ activeSessionId: "session-odysseus" });
  return mount(<BrainUiProvider root={root}>{ui}</BrainUiProvider>);
}

type Tool = keyof typeof GITHUB_TOOL_NAMES;
const spellings = (tool: Tool) =>
  [
    [visibleToolName(GITHUB_TOOL_NAMES[tool], "claude"), "claude"],
    [visibleToolName(GITHUB_TOOL_NAMES[tool], "pi"), "pi"],
    [`mcp__brain_ui__${GITHUB_TOOL_NAMES[tool]}`, "claude"],
  ] as const;

function call(name: string, output: unknown, over: Partial<ToolCallView> = {}): ToolCallView {
  return { id: "g1", name, input: {}, ...(output === undefined ? {} : { output: typeof output === "string" ? output : JSON.stringify(output) }), isError: false, ...over };
}

function output(tool: Tool, result: unknown, backend: "claude" | "pi" = "pi") {
  registerBuiltinRenderers();
  const name = visibleToolName(GITHUB_TOOL_NAMES[tool], backend);
  const renderer = resolveToolRenderer(call(name, undefined), backend)!;
  const Output = renderer.Output!;
  return render(<Output tool={call(name, result)} />);
}

describe("binding", () => {
  test("every tool resolves under every spelling, on both backends, to its GitHub renderer", () => {
    registerBuiltinRenderers();
    const labels: Record<Tool, string> = { read: "GitHub", search: "GitHub search", create: "GitHub issue", comment: "GitHub comment" };
    for (const tool of Object.keys(GITHUB_TOOL_NAMES) as Tool[]) {
      for (const [name, backend] of spellings(tool)) {
        expect(resolveToolRenderer(call(name, undefined), backend)?.label, `${name} on ${backend}`).toBe(labels[tool]);
      }
    }
  });

  test("each read result renders its dedicated component on both backends", () => {
    for (const backend of ["claude", "pi"] as const) {
      expect(output("read", envelope("read", issue()), backend).container.querySelector("[data-github-issue]"), `issue on ${backend}`).not.toBeNull();
      expect(output("read", envelope("read", pull()), backend).container.querySelector("[data-github-pr]"), `PR on ${backend}`).not.toBeNull();
      expect(output("search", envelope("search", search()), backend).container.querySelector("[data-github-results]"), `search on ${backend}`).not.toBeNull();
    }
  });

  test("output that is not a result envelope falls back to its own words", () => {
    const { container } = output("read", "GitHub tool host failed: socket closed");
    expect(container.querySelector("[data-github-issue], [data-github-pr]")).toBeNull();
    expect(container.textContent).toContain("socket closed");
  });

  test("a refusal is drawn in its own words", () => {
    const { container } = output("read", refusal("read", "unavailable", "no_credential", "This host has no GitHub credential for these tools."));
    expect(container.textContent).toContain("This host has no GitHub credential");
  });

  test("the summary names the object, and nothing for an unparsed result", () => {
    registerBuiltinRenderers();
    const name = visibleToolName(GITHUB_TOOL_NAMES.read, "pi");
    const renderer = resolveToolRenderer(call(name, undefined), "pi")!;
    expect(renderer.summary?.(call(name, envelope("read", pull())))).toBe("ithaca/hall #412");
    expect(renderer.summary?.(call(name, "not json"))).toBeNull();
  });
});

describe("absent is absent", () => {
  test("no checks read 'None reported', never passing or zero", () => {
    const fact = output("read", envelope("read", pull({ checks: null }))).container.querySelector("[data-github-fact='checks']")!;
    expect(fact.textContent).toBe("Checks—None reported");
  });

  test("no review reported reads 'Not reported'", () => {
    const pr = pull({ review_decisions: [], reviews: { items: [], total_count: null, has_more: true } });
    expect(output("read", envelope("read", pr)).container.querySelector("[data-github-fact='reviews']")!.textContent).toBe("Reviews—Not reported");
  });

  test("a deleted author reads as @ghost and asks for no avatar, while a named one does", () => {
    const { container } = output("read", envelope("read", issue({ author: author(null, null) })));
    expect(container.textContent).toContain("@ghost");
    const ghost = container.querySelector("[data-avatar-state='ghost']")!;
    expect(ghost.querySelector("img"), "no avatar request for a deleted account").toBeNull();
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources, "the comment author's avatar comes from the brain's route").toContain("http://localhost/api/sessions/session-odysseus/github/avatars/philoetius?size=64");
    expect(sources.some((src) => src?.includes("null") || src?.includes("ghost"))).toBe(false);
  });
});

describe("direct links pass #3797's validator or render nowhere", () => {
  const links = (container: HTMLElement) => [...container.querySelectorAll<HTMLAnchorElement>("a[data-github-link]")].map((a) => a.getAttribute("href"));

  test("valid canonical, comment, review, commit and search URLs each render as a direct link", () => {
    const pr = output("read", envelope("read", pull()));
    expect(links(pr.container)).toEqual(expect.arrayContaining([
      "https://github.com/ithaca/hall/pull/412",
      "https://github.com/ithaca/hall/pull/412#issuecomment-7001",
      "https://github.com/ithaca/hall/pull/412#pullrequestreview-9001",
    ]));
    fireEvent.click(pr.getByRole("tab", { name: /Commits/ }));
    expect(links(pr.container)).toContain("https://github.com/ithaca/hall/commit/b81c0d4a8f3e2d1c0b9a8f7e6d5c4b3a29180716");
    const found = output("search", envelope("search", search()));
    expect(links(found.container)).toContain("https://github.com/ithaca/hall/issues?q=repo%3Aithaca%2Fhall+bow+is%3Aopen");
  });

  for (const [label, swap] of [
    ["another host", (u: string) => u.replace("https://github.com/", "https://github.com.evil.example/")],
    ["another owner and repository", (u: string) => u.replace("/ithaca/hall/", "/circe/aeaea/")],
    ["another number", (u: string) => u.replace("/pull/412", "/pull/413")],
    ["http", (u: string) => u.replace("https:", "http:")],
  ] as const) {
    test(`a URL on ${label} renders no direct link in its slot, and nothing else changes`, () => {
      const base = pull();
      const swapped = pull({
        html_url: swap(base.html_url),
        comments: { ...base.comments, items: base.comments.items.map((c) => ({ ...c, html_url: swap(c.html_url) })) },
        reviews: { ...base.reviews, items: base.reviews.items.map((r) => ({ ...r, html_url: swap(r.html_url) })) },
        commits: { ...base.commits, items: base.commits.items.map((c) => ({ ...c, html_url: swap(c.html_url.replace("/commit/", "/pull/412/commits/")) })) },
      });
      const pr = output("read", envelope("read", swapped));
      expect(links(pr.container), "no direct link in any slot").toEqual([]);
      const reference = output("read", envelope("read", base));
      const words = (el: HTMLElement) => (el.textContent ?? "").replaceAll("GitHub ↗", "");
      expect(words(pr.container), "the rest of the component is unchanged").toBe(words(reference.container));
      const searchUrl = search().search_url;
      if (swap(searchUrl) !== searchUrl) {
        // A search URL has no number, so the number swap leaves it valid.
        const found = output("search", envelope("search", search({ search_url: swap(searchUrl), items: search().items.map((i) => ({ ...i, html_url: swap(i.html_url) })) })));
        expect(links(found.container), "no search or result link").toEqual([]);
      }
      fireEvent.click(within(pr.container).getByRole("tab", { name: /Commits/ }));
      expect(links(pr.container), "no commit link").toEqual([]);
    });
  }

  test("a search URL for another query or repository renders no search link", () => {
    for (const searchUrl of ["https://github.com/ithaca/hall/issues?q=other", "https://github.com/circe/aeaea/issues?q=repo%3Aithaca%2Fhall+bow+is%3Aopen", null]) {
      const found = output("search", envelope("search", search({ search_url: searchUrl })));
      expect(links(found.container).filter((h) => h?.includes("?q="))).toEqual([]);
    }
  });
});

describe("untrusted text, end to end through a tool result", () => {
  test("HTML, script and images stay text; javascript: is inert; the code block shows; https asks first", () => {
    const pwned = globalThis as { __pwned?: boolean };
    pwned.__pwned = false;
    const { container } = output("read", envelope("read", issue({ body: HOSTILE_BODY, body_length: HOSTILE_BODY.length })));
    const body = container.querySelector("[data-github-issue] [data-untrusted-text]")!;
    expect(body.querySelector("script, img, iframe, object, embed"), "no interpreted HTML or content image").toBeNull();
    expect(body.textContent).toContain("<script>");
    expect(body.querySelector("[data-untrusted-image]")).not.toBeNull();
    expect(body.querySelector("[data-untrusted-link-reason='scheme']")?.textContent).toBe("(not a web link)");
    const blocks = [...body.querySelectorAll("pre")].map((pre) => pre.textContent);
    expect(blocks.some((text) => text?.includes("bow --draw 40kg")), "the fenced code block shows").toBe(true);
    expect(blocks.some((text) => text?.startsWith("<script>")), "the HTML is a literal block").toBe(true);
    const asks = body.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!;
    expect(asks.getAttribute("aria-label")).toBe("the steward's report, outside link to ithaca-steward.example, asks first");
    expect(body.querySelector("a")).toBeNull();
    expect(pwned.__pwned).toBe(false);
  });
});

describe("write views W1–W4", () => {
  function approval(tool: "create" | "comment", input: Record<string, unknown>) {
    registerBuiltinRenderers();
    const name = visibleToolName(GITHUB_TOOL_NAMES[tool], "claude");
    const renderer = resolveToolRenderer(call(name, undefined), "claude")!;
    const Input = renderer.Input!;
    return render(<Input tool={call(name, undefined, { input, status: "pending_approval" })} />);
  }

  test("W1: the issue approval shows exactly what will be posted, not posted, with no link", () => {
    const { container, getByRole } = approval("create", { repository: "ithaca/hall", title: "Cellar key log is not signed after dusk", body: "Two **signatures** per opening.", labels: ["stores"] });
    expect(container.textContent).toContain("Not posted");
    expect(container.textContent).toContain("Cellar key log is not signed after dusk");
    expect(container.querySelector("a")).toBeNull();
    fireEvent.click(getByRole("tab", { name: "Exact text" }));
    expect(container.querySelector("[data-github-exact]")?.textContent).toBe("Two **signatures** per opening.");
  });

  test("W2: a posted issue is the real object, with its validated link", () => {
    const { container } = output("create", envelope("create", { kind: "issue_created", repository: "ithaca/hall", number: 401, title: "Cellar key log is not signed after dusk", labels: ["stores"], created_at: "2026-07-12T09:00:00Z", html_url: "https://github.com/ithaca/hall/issues/401" }));
    expect(container.textContent).toContain("Posted by you via Brain");
    expect(container.querySelector("a[data-github-link]")?.getAttribute("href")).toBe("https://github.com/ithaca/hall/issues/401");
  });

  test("W3: declined, changed after approval, and outcome unknown", () => {
    expect(output("create", refusal("create", "approval_declined", "declined", "You chose not to post.")).container.querySelector("[data-github-write='declined']")).not.toBeNull();
    expect(output("create", refusal("create", "approval_declined", "edited", "Edited after approval.")).container.querySelector("[data-github-write='changed']")).not.toBeNull();
    expect(output("comment", refusal("comment", "upstream_error", "network", "GitHub did not answer; the write may still have been made.")).container.querySelector("[data-github-write='unknown']")).not.toBeNull();
    // Any other refusal is the host's own words.
    expect(output("create", refusal("create", "policy_denied", "repository_not_allowed", "ithaca/hall is not open to GitHub writes.")).container.textContent).toContain("not open to GitHub writes");
  });

  test("W4: the comment approval shows the target and the draft, not posted", () => {
    const { container } = approval("comment", { repository: "ithaca/hall", number: 388, body: "Filed #401 for the key log." });
    expect(container.textContent).toContain("Not posted");
    expect(container.textContent).toContain("ithaca/hall #388");
    expect(container.textContent).toContain("Filed #401 for the key log.");
  });

  test("a write's original row shows no preview: only its approval row does", () => {
    registerBuiltinRenderers();
    const name = visibleToolName(GITHUB_TOOL_NAMES.create, "pi");
    const Input = resolveToolRenderer(call(name, undefined), "pi")!.Input!;
    const { container } = render(<Input tool={call(name, undefined, { input: { repository: "ithaca/hall", title: "x" }, status: "complete" })} />);
    expect(container.textContent).toBe("");
  });
});

describe("no fetch until the reader acts", () => {
  test("rendering a PR requests no detail page", () => {
    output("read", envelope("read", pull()));
    expect(requested.filter((url) => url.includes("/github/") && !url.includes("/avatars/"))).toEqual([]);
  });
});

describe("on-demand sections keep their own state", () => {
  test("a section loaded on one tab does not leak into the next tab's section", async () => {
    answer = (url) =>
      url.endsWith("/files")
        ? page("files", [{ filename: "armoury/bow.md", previous_filename: null, status: "modified", additions: 12, deletions: 3, changes: 15 }])
        : page("checks", [{ source: "check_run", name: "axe-line", state: "passed", conclusion: "success", started_at: null, completed_at: null }]);
    const view = output("read", envelope("read", pull()));
    await act(async () => fireEvent.click(view.getByRole("tab", { name: /Files/ })));
    await act(async () => {});
    expect(view.container.textContent).toContain("armoury/bow.md");
    await act(async () => fireEvent.click(view.getByRole("tab", { name: /Checks/ })));
    await act(async () => {});
    const visible = [...view.container.querySelectorAll("[role='tabpanel'] > div")].find((d) => !(d as HTMLElement).hidden)!;
    expect(visible.textContent, "the Checks section shows checks").toContain("axe-line");
    expect(visible.textContent, "and none of the Files rows").not.toContain("armoury/bow.md");
  });
});

const page = (part: string, items: unknown[], next: string | null = null) =>
  Response.json({ kind: "detail_page", repository: "ithaca/hall", number: part === "comments" ? 388 : 412, part, items, total_count: null, next_cursor: next, fetched_at: "2026-07-12T09:00:00Z" });

describe("on-demand detail", () => {
  test("earlier comments leave out the ones the result already shows, and their new authors get no avatar", async () => {
    const shown = issue().comments.items[0]!;
    answer = () => page("comments", [{ ...shown }, { ...shown, id: 5001, author: author("antinous", "NONE"), body: "Nobody is draining anything.", body_length: 28, html_url: "https://github.com/ithaca/hall/issues/388#issuecomment-5001" }]);
    const view = output("read", envelope("read", issue()));
    await act(async () => fireEvent.click(view.getByRole("button", { name: /Load 16 earlier comments/ })));
    await act(async () => {});
    expect(view.container.textContent?.split(shown.body!).length, "the shown comment appears once").toBe(2);
    expect(view.container.textContent).toContain("Nobody is draining anything.");
    const loaded = [...view.container.querySelectorAll("[data-github-comment]")].find((c) => c.textContent?.includes("@antinous"))!;
    expect(loaded.querySelector("img"), "an author only loaded detail names gets initials").toBeNull();
  });

  test("all commits leave out the ones the result already shows", async () => {
    const first = pull().commits.items[0]!;
    answer = () => page("commits", [first, { ...first, sha: "5e02aa7a8f3e2d1c0b9a8f7e6d5c4b3a29180716", message: "Swap gut string for sinew", html_url: "https://github.com/ithaca/hall/commit/5e02aa7a8f3e2d1c0b9a8f7e6d5c4b3a29180716" }]);
    const view = output("read", envelope("read", pull()));
    fireEvent.click(view.getByRole("tab", { name: /Commits/ }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: /Show all commits/ })));
    await act(async () => {});
    expect(view.container.querySelectorAll("[data-github-commit]").length, "the result's commit, then the one new commit").toBe(2);
    expect(view.container.textContent).toContain("Swap gut string for sinew");
  });

  test("Files load on the tab's first open, and keep what they loaded when the reader comes back", async () => {
    answer = () => page("files", [{ filename: "armoury/bow.md", previous_filename: null, status: "modified", additions: 12, deletions: 3, changes: 15 }]);
    const view = output("read", envelope("read", pull()));
    expect(requested.filter((u) => u.endsWith("/files")), "nothing before the tab opens").toEqual([]);
    await act(async () => fireEvent.click(view.getByRole("tab", { name: /Files/ })));
    await act(async () => {});
    expect(requested.filter((u) => u.endsWith("/files"))).toEqual(["/api/sessions/session-odysseus/github/ithaca/hall/412/files"]);
    expect(view.container.textContent).toContain("armoury/bow.md");
    fireEvent.click(view.getByRole("tab", { name: /Conversation/ }));
    await act(async () => fireEvent.click(view.getByRole("tab", { name: /Files/ })));
    expect(requested.filter((u) => u.endsWith("/files")), "coming back does not fetch again").toHaveLength(1);
  });

  for (const [status, error, state, text] of [
    [503, { code: "unavailable", reason: "no_credential", message: "No credential." }, "no-credential", "no GitHub access set up"],
    [404, { code: "not_found", reason: "github", message: "Gone." }, "gone", "no longer shows this pull request"],
    [403, { code: "forbidden", reason: "not_owner", message: "Not yours." }, "gone", "no longer shows this pull request"],
    [502, { code: "upstream_error", reason: "http_502", message: "GitHub answered 502." }, "error", "GitHub answered 502"],
    [429, { code: "rate_limited", reason: "github", message: "Limited." }, "rate-limited", "request limit is used up"],
  ] as const) {
    test(`a ${status} ${error.code} from the route reads as ${state}`, async () => {
      answer = () => Response.json({ error: { ...error, reset_at: null } }, { status });
      const view = output("read", envelope("read", pull()));
      await act(async () => fireEvent.click(view.getByRole("tab", { name: /Files/ })));
      await act(async () => {});
      const section = view.container.querySelector("[data-github-detail]:not([hidden] *)");
      expect([...view.container.querySelectorAll("[data-github-detail]")].map((n) => n.getAttribute("data-github-detail"))).toContain(state);
      expect(view.container.textContent).toContain(text);
      void section;
    });
  }

  test("a skipped check run reads as skipped, not as an absent report", async () => {
    answer = () => page("checks", [{ source: "check_run", name: "nightly-armoury", state: "skipped", conclusion: "skipped", started_at: null, completed_at: null }]);
    const view = output("read", envelope("read", pull()));
    await act(async () => fireEvent.click(view.getByRole("tab", { name: /Checks/ })));
    await act(async () => {});
    expect(view.container.textContent).toContain("nightly-armoury");
    expect(view.container.textContent).toContain("skipped");
    expect(view.container.textContent).not.toContain("None reported");
  });
});

describe("write outcomes say what the host knows", () => {
  test("a write cancelled before sending says so in the host's words, not 'outcome unknown'", () => {
    const { container } = output("create", refusal("create", "upstream_error", "cancelled", "The turn ended before the write was sent; nothing was sent."));
    expect(container.querySelector("[data-github-write='unknown']")).toBeNull();
    expect(container.textContent).toContain("nothing was sent");
  });

  test("after approval, the approval row no longer shows the draft as not posted", () => {
    registerBuiltinRenderers();
    const name = visibleToolName(GITHUB_TOOL_NAMES.create, "claude");
    const Input = resolveToolRenderer(call(name, undefined), "claude")!.Input!;
    for (const status of ["approved", "denied"] as const) {
      const { container } = render(<Input tool={call(name, undefined, { input: { repository: "ithaca/hall", title: "Key log" }, status })} />);
      expect(container.textContent, status).toBe("");
    }
  });
});

describe("review states", () => {
  test("an unsubmitted (pending) review reads as not reported, never as a review request", () => {
    const pr = pull({ reviews: { items: [{ ...pull().reviews.items[0]!, state: "pending", body: null, body_length: 0 }], total_count: 1, has_more: false } });
    const { container } = output("read", envelope("read", pr));
    const review = container.querySelector("[data-github-review]")!;
    expect(review.textContent).toContain("Not reported");
    expect(review.textContent).not.toContain("Requested");
  });
});

describe("the approval card", () => {
  test("a GitHub write names its repository and the design's actions, never the draft as one JSON line", () => {
    const toolCall = { id: "github-1", name: visibleToolName(GITHUB_TOOL_NAMES.create, "claude"), input: { repository: "ithaca/hall", title: "Cellar key log", body: "Two signatures per opening." }, status: "pending_approval" as const };
    const { container, getByRole } = render(<ToolPermissionCard toolCall={toolCall as never} onApproval={() => true} backendId="claude" />);
    expect(container.textContent).toContain("ithaca/hall");
    expect(container.textContent).not.toContain('{"repository"');
    expect(getByRole("button", { name: /Post issue/ })).toBeTruthy();
    expect(getByRole("button", { name: /Don't post/ })).toBeTruthy();
    expect(container.textContent).toContain("Not posted");
  });

  test("a comment names its issue", () => {
    const toolCall = { id: "github-2", name: visibleToolName(GITHUB_TOOL_NAMES.comment, "pi"), input: { repository: "ithaca/hall", number: 388, body: "Filed #401." }, status: "pending_approval" as const };
    const { container, getByRole } = render(<ToolPermissionCard toolCall={toolCall as never} onApproval={() => true} backendId="pi" />);
    expect(container.textContent).toContain("ithaca/hall #388");
    expect(getByRole("button", { name: /Post comment/ })).toBeTruthy();
  });
});
