// The host GitHub tools' results as the ui-kit GitHub components (#3795):
// every spelling on every backend, the fallback, honest absent states, direct
// links only after #3797's validator, untrusted bodies end to end, and the
// write views W1–W4. Props-only, keyless, mounted in happy-dom.
import { registerGithubToolsDom, unregisterGithubToolsDom } from "./github-tools-dom.js";

registerGithubToolsDom();

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render as mount } from "@testing-library/react";
import type { ReactElement } from "react";
import { visibleToolName, type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { GITHUB_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { resetToolRenderers, resolveToolRenderer } from "../../../ui-sdk/src/client/renderers.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
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
});
afterAll(async () => {
  await act(async () => cleanup());
  resetToolRenderers();
  await unregisterGithubToolsDom();
});

function render(ui: ReactElement) {
  const root = createBrainUiRoot({
    storage: null,
    request: async (url) => {
      requested.push(String(url));
      return new Response("{}", { status: 404 });
    },
  });
  roots.push(root);
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

  test("a deleted author reads as @ghost and asks for no avatar", () => {
    const { container } = output("read", envelope("read", issue({ author: author(null, null) })));
    expect(container.textContent).toContain("@ghost");
    expect(container.querySelector("[data-github-issue] header img, [data-github-issue] img[src*='/avatars/null']")).toBeNull();
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
      expect(pr.container.textContent).toContain("Restring the great bow before the contest");
      fireEvent.click(pr.getByRole("tab", { name: /Commits/ }));
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
    const page = { kind: "detail_page", repository: "ithaca/hall", number: 412, part: "files", items: [{ filename: "armoury/bow.md", previous_filename: null, status: "modified", additions: 12, deletions: 3, changes: 15 }], total_count: 1, next_cursor: null, fetched_at: "2026-07-12T09:00:00Z" };
    registerBuiltinRenderers();
    const name = visibleToolName(GITHUB_TOOL_NAMES.read, "pi");
    const Output = resolveToolRenderer(call(name, undefined), "pi")!.Output!;
    const root = createBrainUiRoot({ storage: null, request: async () => Response.json(page) });
    roots.push(root);
    root.stores.chat.setState({ activeSessionId: "session-odysseus" });
    const view = mount(<BrainUiProvider root={root}><Output tool={call(name, envelope("read", pull()))} /></BrainUiProvider>);
    fireEvent.click(view.getByRole("tab", { name: /Files/ }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: /Show files/ })));
    await act(async () => {});
    expect(view.container.textContent).toContain("armoury/bow.md");
    fireEvent.click(view.getByRole("tab", { name: /Checks/ }));
    expect(view.container.querySelector("[data-github-detail]")?.getAttribute("data-github-detail"), "the Checks section starts idle").toBe("idle");
    expect(view.container.textContent).not.toContain("armoury/bow.md");
  });
});
