/**
 * The GitHub tool cards in a real browser (#3795):
 *
 * - while the components render (avatars, an open interstitial, loaded detail
 *   sections) no request leaves the brain's own origin;
 * - an untrusted https link opens only after the interstitial shows its full
 *   address;
 * - each on-demand section fetches only after the reader acts, through
 *   #3796's route, and renders its typed errors (here, rate limited);
 * - loading detail changes nothing the model sees: the chat store is
 *   byte-identical before and after;
 * - a review's "Show n line comments" loads only after its press, and only
 *   that review's comments, under it (#4147).
 *
 * The detail route is answered by the root's `request`, the one seam every
 * #3796 call goes through, so no network is involved; avatars are real <img>
 * requests to the page's own origin.
 */
import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { visibleToolName, type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { GITHUB_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { resolveToolRenderer } from "../../../ui-sdk/src/client/renderers.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { FETCHED, HOSTILE_BODY, envelope, pull } from "../github-fixtures.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    startRequestLog: () => Promise<void>;
    requestLog: (options?: { settle: boolean }) => Promise<string[]>;
  }
}

let host: HTMLDivElement | undefined;
let renderer: Root | undefined;
let root: BrainUiRoot | undefined;
afterEach(() => {
  if (renderer) flushSync(() => renderer!.unmount());
  root?.dispose();
  host?.remove();
  renderer = undefined;
  root = undefined;
  host = undefined;
});

const FILES_PAGE = {
  kind: "detail_page",
  repository: "ithaca/hall",
  number: 412,
  part: "files",
  items: [{ filename: "armoury/bow.md", previous_filename: null, status: "modified", additions: 12, deletions: 3, changes: 15 }],
  total_count: 1,
  next_cursor: null,
  fetched_at: FETCHED,
};
const RESET = new Date(Date.now() + 12 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Two reviews with known counts (#4147), and one page holding both reviews' line comments. */
const REVIEW_A = 9101, REVIEW_B = 9102;
const countedReview = (id: number, login: string, count: number, day: number) => ({
  id,
  author: { login, is_bot: false, author_association: "MEMBER" as const },
  state: "commented" as const,
  submitted_at: `2026-07-0${day}T09:00:00Z`,
  body: `Review by ${login}.`,
  body_length: 11 + login.length,
  body_truncated: false,
  html_url: `https://github.com/ithaca/hall/pull/412#pullrequestreview-${id}`,
  line_comments: count,
});
const lineComment = (id: number, review: number) => ({
  id,
  review_id: review,
  in_reply_to_id: null,
  author: { login: "eurycleia", is_bot: false, author_association: "MEMBER" as const },
  path: "armoury/bow.md",
  line: 3,
  created_at: "2026-07-05T09:00:00Z",
  updated_at: "2026-07-05T09:00:00Z",
  body: `Line note ${id} on review ${review}.`,
  body_length: 30,
  body_truncated: false,
  html_url: `https://github.com/ithaca/hall/pull/412#discussion_r${id}`,
});
const LINE_COMMENTS_PAGE = { ...FILES_PAGE, part: "review-comments", items: [lineComment(801, REVIEW_A), lineComment(802, REVIEW_B), lineComment(803, REVIEW_A)], total_count: null };

const methods: string[] = [];
/** Mounts a PR read result; returns the detail-route calls the root's `request` saw. */
function mountPullRequest(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  methods.length = 0;
  root = createBrainUiRoot({
    storage: null,
    request: async (url, init) => {
      const path = String(url);
      calls.push(path);
      methods.push(init?.method ?? "GET");
      if (path.endsWith("/files")) return Response.json(FILES_PAGE);
      if (path.endsWith("/review-comments")) return Response.json(LINE_COMMENTS_PAGE);
      if (path.endsWith("/checks"))
        return Response.json({ error: { code: "rate_limited", reason: "github", message: "GitHub's request limit is used up.", reset_at: RESET } }, { status: 429 });
      return Response.json({}, { status: 404 });
    },
  });
  root.stores.chat.setState({ activeSessionId: "session-odysseus" });
  registerBuiltinRenderers(root.renderers);
  const name = visibleToolName(GITHUB_TOOL_NAMES.read, "claude");
  const tool: ToolCallView = { id: "g1", name, input: { repository: "ithaca/hall", number: 412 }, output: JSON.stringify(envelope("read", pull({ body: HOSTILE_BODY, body_length: HOSTILE_BODY.length, ...over }))), isError: false };
  const Output = (root.renderers.resolve(tool, "claude") ?? resolveToolRenderer(tool, "claude"))!.Output!;
  host = document.createElement("div");
  host.style.cssText = "width:680px;padding:16px;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={root!}><Output tool={tool} /></BrainUiProvider>));
  return calls;
}

const tabNamed = (name: string) => [...host!.querySelectorAll<HTMLElement>("[role='tab']")].find((t) => t.textContent?.startsWith(name))!;
const detailCalls = (calls: string[]) => calls.filter((url) => /\/github\/ithaca\/hall\/412\//.test(url));
const foreign = (urls: string[]) => urls.filter((url) => !url.startsWith(location.origin) && !url.startsWith("data:"));

test("nothing leaves the brain's origin, links ask first, and detail loads only when asked", async () => {
  await page.viewport(900, 900);
  await commands.startRequestLog();
  const calls = mountPullRequest();
  const history = JSON.stringify(root!.stores.chat.getState());

  // Avatars are real requests, to this origin only (positive control for the log).
  await expect.poll(() => host!.querySelectorAll("img").length).toBeGreaterThan(0);
  for (const img of host!.querySelectorAll("img")) expect(new URL(img.src).origin, "avatar from the brain's origin").toBe(location.origin);
  expect(detailCalls(calls), "no detail page before the reader acts").toEqual([]);

  // An untrusted https link opens nothing until the interstitial shows its full address.
  const navigated: string[] = [];
  const stop = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (anchor && !anchor.matches("[data-github-link]")) {
      navigated.push(anchor.href);
      event.preventDefault();
    }
  };
  document.addEventListener("click", stop, true);
  try {
    await userEvent.click(host!.querySelector<HTMLButtonElement>("button[data-untrusted-link]")!);
    const gate = document.querySelector<HTMLDialogElement>("dialog[data-untrusted-gate]")!;
    expect(gate.open, "the interstitial is open").toBe(true);
    expect(navigated, "nothing navigated on activation").toEqual([]);
    expect(gate.querySelector("[data-untrusted-gate-address]")?.textContent).toBe("https://ithaca-steward.example/r?id=7");
    await userEvent.click(gate.querySelector<HTMLAnchorElement>("a[data-untrusted-open]")!);
    expect(navigated, "only Open navigates, to the address shown").toEqual(["https://ithaca-steward.example/r?id=7"]);
  } finally {
    document.removeEventListener("click", stop, true);
  }

  // Files: the tab's first open is the reader's act, and loads its section (§7).
  await userEvent.click(tabNamed("Files"));
  await expect.poll(() => host!.textContent).toContain("armoury/bow.md");
  expect(detailCalls(calls)).toEqual(["/api/sessions/session-odysseus/github/ithaca/hall/412/files"]);

  // Checks: a typed rate-limit error reads as S5, with its reset time.
  await userEvent.click(tabNamed("Checks"));
  await expect.poll(() => [...host!.querySelectorAll("[data-github-detail]")].map((n) => n.getAttribute("data-github-detail"))).toContain("rate-limited");
  expect(host!.textContent).toMatch(/It resets at \d{2}:\d{2} \(in 1[12] min\)/);

  // Loaded detail is display-only. Every request the card made is a GET to
  // #3796's read-only detail route, which the server proves leaves the
  // session's provider history unchanged (GITHUB_DETAIL_HISTORY_UNCHANGED,
  // packages/ui-server/tests/ws-github-details.test.ts); and the client's chat
  // state, the turn's source on this side, is byte-identical.
  expect(calls.every((url) => /^\/api\/sessions\/session-odysseus\/github\/ithaca\/hall\/412\/(files|checks)$/.test(url)), `only detail-route calls: ${calls.join(", ")}`).toBe(true);
  expect(methods.every((m) => m === "GET"), "only reads").toBe(true);
  expect(JSON.stringify(root!.stores.chat.getState()), "loading detail changes nothing the model's turn is built from").toBe(history);
  // The page's only network requests are the avatar images (the detail route
  // answers through the root's request): once every image has settled, the
  // log is complete.
  await expect.poll(() => [...host!.querySelectorAll("img")].every((img) => img.complete), { timeout: 5000 }).toBe(true);
  const log = await commands.requestLog();
  expect(log.some((url) => url.includes("/github/avatars/")), "positive control: the log sees the avatar requests").toBe(true);
  expect(foreign(log), "no request left the brain's origin").toEqual([]);
});

test("a review's line comments load on its press, under it, and never another review's (#4147)", async () => {
  await page.viewport(900, 900);
  const calls = mountPullRequest({ reviews: { items: [countedReview(REVIEW_A, "eurycleia", 2, 3), countedReview(REVIEW_B, "argos", 1, 4)], total_count: 2, has_more: false } });
  const history = JSON.stringify(root!.stores.chat.getState());
  const review = (login: string) => host!.querySelector<HTMLElement>(`[data-github-review][aria-label="Review by @${login}"]`)!;
  const show = (login: string) => [...review(login).querySelectorAll("button")].find((b) => /^Show \d+ line comments?$/.test(b.textContent ?? ""));
  expect(show("eurycleia")?.textContent).toBe("Show 2 line comments");
  expect(show("argos")?.textContent).toBe("Show 1 line comment");
  expect(host!.textContent, "the PR-wide section is retired").not.toMatch(/Show line comments/);
  expect(detailCalls(calls), "no detail page before the reader acts").toEqual([]);

  await userEvent.click(show("eurycleia")!);
  await expect.poll(() => review("eurycleia").textContent).toContain("Line note 803 on review 9101.");
  expect(review("eurycleia").textContent).toContain("Line note 801 on review 9101.");
  expect(host!.textContent, "another review's comment is not drawn").not.toContain("Line note 802");
  expect(detailCalls(calls)).toEqual(["/api/sessions/session-odysseus/github/ithaca/hall/412/review-comments"]);
  expect(show("argos"), "the other review is still idle").toBeTruthy();

  await userEvent.click(show("argos")!);
  await expect.poll(() => review("argos").textContent).toContain("Line note 802 on review 9102.");
  expect(review("argos").textContent).not.toContain("Line note 801");
  expect(review("eurycleia").textContent).not.toContain("Line note 802");
  expect(methods.every((m) => m === "GET"), "only reads").toBe(true);
  expect(JSON.stringify(root!.stores.chat.getState()), "loading line comments changes nothing the model's turn is built from").toBe(history);
});
