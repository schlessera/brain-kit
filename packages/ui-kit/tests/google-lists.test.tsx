/**
 * The Gmail standing-permission lists (#4212) as markup and as a live tree:
 * the action words for every kind, grouping, busy rows, the empty,
 * unavailable and error states, the amber-at-ten rule, and where focus goes
 * when a revoke removes the focused row. What only a browser can answer (the
 * 320px and 680px layouts, both themes, real targets, the a11y gate) is the
 * stories' in `stories/google/`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { GoogleAllowanceList, type GoogleAllowanceListProps } from "../src/google/GoogleAllowanceList.js";
import { GoogleApprovalList, type GoogleApprovalListProps } from "../src/google/GoogleApprovalList.js";
import { googleActionWords, type GoogleStandingAction } from "../src/google/shared.js";
import { accent, color } from "../src/tokens.js";

const ODYSSEUS = "odysseus@example.com";
const PENELOPE = "penelope@example.com";
const SAT = { short: "Sat 11 Jul", full: "Saturday 11 July 2026 at 09:14" };
const UNTIL = { short: "18:02", full: "Sunday 12 July 2026 at 18:02" };
const noop = () => {};

function draw(element: ReactElement): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document as unknown as Document;
}

const names = (doc: Document) => [...doc.querySelectorAll("[role='button']")].map((el) => el.getAttribute("aria-label"));

describe("googleActionWords", () => {
  test.each([
    [{ kind: "archive" }, "Archive"],
    [{ kind: "unarchive" }, "Move to inbox"],
    [{ kind: "mark_read" }, "Mark as read"],
    [{ kind: "mark_unread" }, "Mark as unread"],
    [{ kind: "star" }, "Star"],
    [{ kind: "unstar" }, "Remove star"],
    [{ kind: "drafts" }, "Save drafts"],
    [{ kind: "label", labelId: "Label_12", labelName: "Voyage" }, "Add label “Voyage”"],
    [{ kind: "unlabel", labelId: "Label_7", labelName: "Suitors" }, "Remove label “Suitors”"],
    [{ kind: "label", labelId: "Label_31", labelName: "Estate · herds and orchards" }, "Add label “Estate · herds and orchards”"],
  ] as [GoogleStandingAction, string][])("%o reads %p", (action, text) => {
    expect(googleActionWords(action)).toEqual({ text });
  });

  test("a withheld label name falls back to the label id, in mono", () => {
    expect(googleActionWords({ kind: "label", labelId: "Label_7", labelName: null }), "KIT_GOOGLE_WITHHELD_NAME").toEqual({ text: "Add label", mono: "Label_7" });
    expect(googleActionWords({ kind: "unlabel", labelId: "Label_12", labelName: null })).toEqual({ text: "Remove label", mono: "Label_12" });
    expect(googleActionWords({ kind: "label", labelId: "Label_9", labelName: "" }), "an empty name is withheld too").toEqual({ text: "Add label", mono: "Label_9" });
  });

  test("a drawn label name is isolated plain text; a withheld one draws its id", () => {
    const named = draw(<GoogleApprovalList state="ready" accounts={[{ address: ODYSSEUS, approvals: [{ id: "a", action: { kind: "label", labelId: "Label_12", labelName: "<b>Voyage</b>" }, since: SAT }] }]} onRevoke={noop} />);
    expect(named.querySelector("bdi")?.textContent, "the name is text, never markup").toBe("<b>Voyage</b>");
    expect(named.querySelector("b")).toBeNull();
    expect(named.querySelector("[data-google-title]")?.textContent, "KIT_GOOGLE_QUOTED_NAME").toBe("Add label “<b>Voyage</b>”");
    expect(named.querySelector("bdi")?.previousSibling?.textContent, "the quotes sit outside the isolated name").toMatch(/“$/);
    expect(names(named)).toEqual([`Revoke Add label “<b>Voyage</b>” for ${ODYSSEUS}`]);
    const withheld = draw(<GoogleApprovalList state="ready" accounts={[{ address: ODYSSEUS, approvals: [{ id: "a", action: { kind: "label", labelId: "Label_7", labelName: null }, since: SAT }] }]} onRevoke={noop} />);
    expect(withheld.querySelector("bdi")).toBeNull();
    expect(withheld.querySelector("[data-google-label-id]")?.textContent).toBe("Label_7");
    expect(names(withheld)).toEqual([`Revoke Add label Label_7 for ${ODYSSEUS}`]);
    expect(withheld.body.textContent, "a withheld name's id is never quoted").not.toMatch(/[“”]/);
  });
});

const twoAccounts = (): GoogleApprovalListProps["accounts"] => [
  { address: ODYSSEUS, approvals: [{ id: "archive", action: { kind: "archive" }, since: SAT }, { id: "drafts", action: { kind: "drafts" }, since: SAT }] },
  { address: "telemachus@example.com", approvals: [] },
  { address: PENELOPE, approvals: [{ id: "star", action: { kind: "star" }, since: SAT }] },
];

describe("GoogleApprovalList", () => {
  test("groups rows by account, under each address, and skips an account with none", () => {
    const doc = draw(<GoogleApprovalList state="ready" accounts={twoAccounts()} onRevoke={noop} />);
    const groups = [...doc.querySelectorAll("[data-google-account]")];
    expect(groups.map((group) => group.firstElementChild?.textContent)).toEqual([ODYSSEUS, PENELOPE]);
    expect(groups.map((group) => group.querySelectorAll("[role='button']").length)).toEqual([2, 1]);
    expect(names(doc)).toEqual([`Revoke Archive for ${ODYSSEUS}`, `Revoke Save drafts for ${ODYSSEUS}`, `Revoke Star for ${PENELOPE}`]);
    const row = doc.querySelector("[role='button']")!;
    expect(doc.getElementById(row.getAttribute("aria-describedby")!)?.textContent, "the full time describes the row").toBe("since Saturday 11 July 2026 at 09:14");
    expect(row.textContent).toContain("since Sat 11 Jul");
  });

  test("each account is a group named by its address, holding a list with an item per approval", () => {
    const doc = draw(<GoogleApprovalList state="ready" accounts={twoAccounts()} onRevoke={noop} />);
    const groups = [...doc.querySelectorAll("[role='group']")];
    expect(groups.map((group) => doc.getElementById(group.getAttribute("aria-labelledby")!)?.textContent), "KIT_GOOGLE_GROUP_NAMES").toEqual([ODYSSEUS, PENELOPE]);
    expect(groups.map((group) => [...group.querySelectorAll("ul[role='list'] > li")].length)).toEqual([2, 1]);
    expect(doc.querySelectorAll("li [role='button']"), "every row control sits in a list item").toHaveLength(3);
  });

  test("one account still shows its address", () => {
    const doc = draw(<GoogleApprovalList state="ready" accounts={[twoAccounts()[0]!]} onRevoke={noop} />);
    expect(doc.querySelector("[data-google-account]")?.firstElementChild?.textContent).toBe(ODYSSEUS);
  });

  test("a busy row reads Revoking…, dims and announces itself disabled; the others do not", () => {
    const doc = draw(<GoogleApprovalList state="ready" accounts={twoAccounts()} busy="drafts" onRevoke={noop} />);
    const [archive, drafts] = [...doc.querySelectorAll<HTMLElement>("[role='button']")] as [HTMLElement, HTMLElement];
    expect(drafts.getAttribute("aria-disabled"), "KIT_GOOGLE_BUSY_DISABLED").toBe("true");
    expect(drafts.getAttribute("tabindex"), "still a tab stop").toBe("0");
    expect(drafts.textContent).toContain("Revoking…");
    expect(drafts.querySelector<HTMLElement>(".bk-google-row-title")!.style.color).toBe(color.inkDim);
    expect(archive.getAttribute("aria-disabled")).toBeNull();
    expect(archive.textContent).toContain("Revoke");
    expect(archive.textContent).not.toContain("Revoking…");
    expect(archive.querySelector<HTMLElement>(".bk-google-row-title")!.style.color).toBe(color.ink);
  });

  test("empty, unavailable and error states", () => {
    const empty = draw(<GoogleApprovalList state="ready" accounts={[{ address: ODYSSEUS, approvals: [] }]} onRevoke={noop} />);
    expect(empty.body.textContent).toContain("None yet. Every Gmail change asks first. Choose “Allow always” on a card to remember one.");
    expect(empty.querySelector("[data-google-account]")).toBeNull();

    const unavailable = draw(<GoogleApprovalList state="unavailable" accounts={twoAccounts()} onRevoke={noop} />);
    expect(unavailable.body.textContent).toContain("Remembered approvals can't be read right now, so every Gmail change asks until they can.");
    expect(unavailable.querySelectorAll("[role='button']"), "unavailable draws no rows").toHaveLength(0);

    const loading = draw(<GoogleApprovalList state="loading" accounts={twoAccounts()} onRevoke={noop} />);
    expect(loading.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(loading.querySelectorAll("[aria-busy='true'] .bk-ghost"), "two ghost lines").toHaveLength(2);
    expect(loading.querySelectorAll("[role='button']")).toHaveLength(0);

    const error = draw(<GoogleApprovalList state="ready" accounts={twoAccounts()} error="Couldn't revoke Archive." onRevoke={noop} />);
    expect(error.querySelector("[role='alert']")?.textContent).toBe("Couldn't revoke Archive.");
    expect(error.querySelectorAll("[role='button']"), "the rows stay").toHaveLength(3);
    expect(draw(<GoogleApprovalList state="ready" accounts={twoAccounts()} onRevoke={noop} />).querySelector("[role='alert']")).toBeNull();
  });
});

const grant = (id: string, remaining: number, address = ODYSSEUS, actions: GoogleStandingAction[] = [{ kind: "archive" }]): GoogleAllowanceListProps["grants"][number] =>
  ({ id, address, actions, remaining, limit: 100, until: UNTIL });

describe("GoogleAllowanceList", () => {
  test("the count turns amber at ten left, not at eleven, and words carry it", () => {
    const doc = draw(<GoogleAllowanceList state="ready" grants={[grant("eleven", 11), grant("ten", 10), grant("one", 1)]} onRevoke={noop} />);
    const metas = [...doc.querySelectorAll<HTMLElement>("[data-google-meta]")];
    expect(metas.map((meta) => meta.textContent)).toEqual([
      "11 of 100 changes left · until 18:02",
      "10 of 100 changes left · until 18:02",
      "1 of 100 changes left · until 18:02",
    ]);
    expect(metas.map((meta) => meta.style.color), "KIT_GOOGLE_AMBER_AT_TEN").toEqual([color.inkMute, accent.amber.ink, accent.amber.ink]);
  });

  test("a used-up grant says so, dims and stays revocable", () => {
    const doc = draw(<GoogleAllowanceList state="ready" grants={[grant("used", 0), grant("open", 40)]} onRevoke={noop} />);
    const [used, open] = [...doc.querySelectorAll<HTMLElement>("[data-google-grant]")] as [HTMLElement, HTMLElement];
    expect(used.dataset.googleGrant).toBe("used");
    expect(used.querySelector("[data-google-meta]")?.textContent).toBe("All 100 used · each change asks again");
    expect((used.firstElementChild!.firstElementChild as HTMLElement).style.color).toBe(color.inkDim);
    expect((open.firstElementChild!.firstElementChild as HTMLElement).style.color).toBe(color.ink);
    expect(used.querySelector("[role='button']")?.getAttribute("aria-disabled"), "still revocable").toBeNull();
  });

  test("actions join with · and names with and; the address shows only across accounts", () => {
    const actions: GoogleStandingAction[] = [{ kind: "archive" }, { kind: "mark_read" }, { kind: "label", labelId: "Label_12", labelName: "Voyage" }];
    const one = draw(<GoogleAllowanceList state="ready" grants={[grant("a", 84, ODYSSEUS, actions)]} onRevoke={noop} />);
    expect(one.querySelector("[data-google-grant]")?.textContent).toContain("Archive · Mark as read · Add label “Voyage”");
    expect(names(one)).toEqual(["Revoke Archive, Mark as read and Add label “Voyage”"]);
    expect(one.body.textContent, "one account: no address").not.toContain(ODYSSEUS);
    const button = one.querySelector("[role='button']")!;
    expect(one.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("until Sunday 12 July 2026 at 18:02");

    const two = draw(<GoogleAllowanceList state="ready" grants={[grant("a", 84, ODYSSEUS, actions.slice(0, 2)), grant("b", 40, PENELOPE, [{ kind: "drafts" }])]} onRevoke={noop} />);
    expect(two.body.textContent).toContain(ODYSSEUS);
    expect(two.body.textContent).toContain(PENELOPE);
    expect(names(two)).toEqual([`Revoke Archive and Mark as read for ${ODYSSEUS}`, `Revoke Save drafts for ${PENELOPE}`]);
  });

  test("the grants are a list, one item per card", () => {
    const doc = draw(<GoogleAllowanceList state="ready" grants={[grant("a", 84), grant("b", 3), grant("c", 0)]} onRevoke={noop} />);
    expect(doc.querySelectorAll("ul[role='list']")).toHaveLength(1);
    expect([...doc.querySelectorAll("ul[role='list'] > li")].map((item) => item.getAttribute("data-google-target"))).toEqual(["a", "b", "c"]);
    expect(doc.querySelectorAll("[role='group']"), "allowances have no account groups").toHaveLength(0);
  });

  test("loading draws the busy placeholder with two ghost lines, and no rows", () => {
    const loading = draw(<GoogleAllowanceList state="loading" grants={[grant("a", 84)]} onRevoke={noop} />);
    expect(loading.querySelector("[aria-busy='true']"), "KIT_GOOGLE_LOADING_BUSY").not.toBeNull();
    expect(loading.querySelectorAll("[aria-busy='true'] .bk-ghost"), "KIT_GOOGLE_LOADING_LINES").toHaveLength(2);
    expect(loading.querySelectorAll("[role='button'], ul")).toHaveLength(0);
  });

  test("with nothing to list, the explainer is its first sentence; with grants, all of it", () => {
    const lead = "This chat is restricted, so remembered approvals are off.";
    const full = `${lead} You allowed these on a card here. They end at the time shown, when the chat returns to normal, when the policy changes or when Brain restarts.`;
    const explainer = (element: ReactElement) => draw(element).querySelector("p")?.textContent;
    expect(explainer(<GoogleAllowanceList state="ready" grants={[]} onRevoke={noop} />), "KIT_GOOGLE_EXPLAINER_LEAD").toBe(lead);
    expect(explainer(<GoogleAllowanceList state="loading" grants={[grant("a", 84)]} onRevoke={noop} />)).toBe(lead);
    expect(explainer(<GoogleAllowanceList state="unavailable" grants={[grant("a", 84)]} onRevoke={noop} />)).toBe(lead);
    expect(explainer(<GoogleAllowanceList state="ready" grants={[grant("a", 84)]} onRevoke={noop} />)).toBe(full);
  });

  test("busy, empty, unavailable and error states", () => {
    const busy = draw(<GoogleAllowanceList state="ready" grants={[grant("a", 84), grant("b", 3)]} busy="a" onRevoke={noop} />);
    const [a, b] = [...busy.querySelectorAll("[role='button']")] as [Element, Element];
    expect([a.textContent, a.getAttribute("aria-disabled"), a.getAttribute("tabindex")]).toEqual(["Revoking…", "true", "0"]);
    expect([b.textContent, b.getAttribute("aria-disabled")]).toEqual(["Revoke", null]);

    expect(draw(<GoogleAllowanceList state="ready" grants={[]} onRevoke={noop} />).body.textContent).toContain("Nothing is allowed in this chat. Each Gmail change asks.");
    const unavailable = draw(<GoogleAllowanceList state="unavailable" grants={[grant("a", 84)]} onRevoke={noop} />);
    expect(unavailable.body.textContent).toContain("Allowances for this chat can't be read right now, so each Gmail change asks until they can.");
    expect(unavailable.querySelectorAll("[role='button']")).toHaveLength(0);
    const error = draw(<GoogleAllowanceList state="ready" grants={[grant("a", 84)]} error="Couldn't revoke Archive." onRevoke={noop} />);
    expect(error.querySelector("[role='alert']")?.textContent).toBe("Couldn't revoke Archive.");
    expect(error.querySelectorAll("[role='button']")).toHaveLength(1);
  });
});

/* ── Focus after a revoke, in a live tree ──────────────────────────────── */

const saved = new Map<string, PropertyDescriptor | undefined>();
let win: Window;
let root: Root | undefined;
let host: HTMLDivElement;
beforeAll(() => {
  win = new Window();
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  win.document.body.innerHTML = "";
});
afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(element: ReactElement) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(element));
}

const approvals = (ids: string[]) => (
  <GoogleApprovalList
    state="ready"
    accounts={[{ address: ODYSSEUS, approvals: ids.map((id) => ({ id, action: { kind: "archive" } as const, since: SAT })) }]}
    onRevoke={noop}
  />
);
const allowances = (ids: string[]) => <GoogleAllowanceList state="ready" grants={ids.map((id) => grant(id, 84))} onRevoke={noop} />;

/** The focus target for `id`: an approval row, or an allowance row's Revoke. */
function target(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-google-target="${id}"]`)!;
  return row.getAttribute("role") === "button" ? row : row.querySelector<HTMLElement>("[role='button']")!;
}
const heading = () => document.querySelector<HTMLElement>("[role='heading']")!;

async function focus(el: HTMLElement) {
  await act(async () => el.focus());
  expect(document.activeElement).toBe(el);
}

for (const [list, draw] of [["approval list", approvals], ["allowance list", allowances]] as const) {
  describe(`${list}: focus after a revoke removes the focused row`, () => {
    test("a middle row hands focus to the next one", async () => {
      await render(draw(["a", "b", "c"]));
      await focus(target("b"));
      await render(draw(["a", "c"]));
      expect(document.activeElement, "KIT_GOOGLE_FOCUS_NEXT").toBe(target("c"));
    });

    test("the last row hands focus to the previous one", async () => {
      await render(draw(["a", "b", "c"]));
      await focus(target("c"));
      await render(draw(["a", "b"]));
      expect(document.activeElement, "KIT_GOOGLE_FOCUS_PREVIOUS").toBe(target("b"));
    });

    test("the only row hands focus to the heading", async () => {
      await render(draw(["a"]));
      await focus(target("a"));
      await render(draw([]));
      expect(heading().getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement, "KIT_GOOGLE_FOCUS_HEADING").toBe(heading());
    });

    test("a replaced list hands focus to its first row: [a] → [b]", async () => {
      await render(draw(["a"]));
      await focus(target("a"));
      await render(draw(["b"]));
      expect(document.activeElement, "KIT_GOOGLE_FOCUS_REPLACED").toBe(target("b"));
    });

    test("when every old row is replaced, focus goes to the first row now shown", async () => {
      await render(draw(["a", "b", "c"]));
      await focus(target("b"));
      await render(draw(["x", "y"]));
      expect(document.activeElement, "KIT_GOOGLE_FOCUS_REPLACED").toBe(target("x"));
    });

    test("a row that drops while another holds focus moves nothing", async () => {
      await render(draw(["a", "b", "c"]));
      await focus(target("a"));
      await render(draw(["a", "c"]));
      expect(document.activeElement).toBe(target("a"));
    });

    test("focus that has left the list is not pulled back", async () => {
      const outside = document.createElement("button");
      document.body.append(outside);
      await render(draw(["a", "b"]));
      await focus(target("a"));
      await focus(outside);
      await render(draw(["b"]));
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });
}

/*
 * A list rendered into a second document, as into a same-origin frame by a
 * parent-realm root: its focus must be read from its own document. Here the
 * module's document has an outside button focused (as a parent document has
 * its frame focused), which a check on the wrong document would take for
 * focus the user moved elsewhere.
 */
describe("a list in another document reads that document's focus", () => {
  for (const [list, draw] of [["approval list", approvals], ["allowance list", allowances]] as const) {
    test(`${list}: the next row takes focus in the list's own document`, async () => {
      const frame = new Window();
      const frameDoc = frame.document as unknown as Document;
      const frameHost = frameDoc.createElement("div");
      frameDoc.body.append(frameHost);
      const frameRoot = createRoot(frameHost);
      const outside = document.createElement("button");
      document.body.append(outside);
      try {
        await act(async () => frameRoot.render(draw(["a", "b", "c"])));
        await act(async () => outside.focus());
        expect(document.activeElement, "the module's document holds focus elsewhere").toBe(outside);
        const row = (id: string) => {
          const host = frameDoc.querySelector<HTMLElement>(`[data-google-target="${id}"]`)!;
          return host.getAttribute("role") === "button" ? host : host.querySelector<HTMLElement>("[role='button']")!;
        };
        await act(async () => row("b").focus());
        expect(frameDoc.activeElement, "the frame's row holds the frame's focus").toBe(row("b"));
        await act(async () => frameRoot.render(draw(["a", "c"])));
        expect(frameDoc.activeElement, "KIT_GOOGLE_FOCUS_OWNER_DOCUMENT").toBe(row("c"));
      } finally {
        await act(async () => frameRoot.unmount());
        outside.remove();
        await frame.happyDOM.close();
      }
    });
  }
});

/* ── A failed read, and rows the host cannot show (#4212 round 2) ────────── */

const APPROVAL_FAILED = "Couldn't load remembered approvals.";
const APPROVAL_FAILED_DETAIL = "Any you have may still run without asking.";
const ALLOWANCE_FAILED = "Couldn't load this chat's allowances.";
const ALLOWANCE_FAILED_DETAIL = "Any you allowed here may still apply.";
const APPROVAL_EMPTY = "None yet.";
const ALLOWANCE_EMPTY = "Nothing is allowed in this chat.";

describe("a failed read", () => {
  for (const [list, element, failed, detail, empty, unavailable] of [
    ["approval list", (p: Partial<GoogleApprovalListProps>) => <GoogleApprovalList state="failed" accounts={twoAccounts()} onRevoke={noop} {...p} />, APPROVAL_FAILED, APPROVAL_FAILED_DETAIL, APPROVAL_EMPTY, "can't be read right now"],
    ["allowance list", (p: Partial<GoogleAllowanceListProps>) => <GoogleAllowanceList state="failed" grants={[grant("a", 84)]} onRevoke={noop} {...p} />, ALLOWANCE_FAILED, ALLOWANCE_FAILED_DETAIL, ALLOWANCE_EMPTY, "can't be read right now"],
  ] as const) {
    test(`${list}: says the read failed, claims no empty list and nothing running, and draws no rows`, () => {
      const doc = draw(element({ onRetry: noop, unshown: 3 }));
      const box = doc.querySelector("[data-google-approvals], [data-google-allowances]")!;
      expect(box.getAttribute(box.hasAttribute("data-google-approvals") ? "data-google-approvals" : "data-google-allowances")).toBe("failed");
      expect(doc.querySelector("[data-google-failed]")?.textContent, "KIT_GOOGLE_FAILED_COPY").toBe(`${failed}${detail}Try again`);
      expect(doc.querySelector("[aria-busy]"), "KIT_GOOGLE_FAILED_NOT_BUSY").toBeNull();
      expect(doc.querySelectorAll(".bk-ghost"), "no loading ghost").toHaveLength(0);
      expect(doc.body.textContent, "KIT_GOOGLE_FAILED_NOT_EMPTY").not.toContain(empty);
      expect(doc.body.textContent, "not the unavailable claim either").not.toContain(unavailable);
      expect(doc.querySelectorAll("[data-google-target], ul"), "no rows").toHaveLength(0);
      expect(doc.querySelector("[data-google-unshown]"), "a count is read only when ready").toBeNull();
      expect(names(doc), "KIT_GOOGLE_RETRY_OFFERED").toEqual([null]);
      expect([...doc.querySelectorAll("[role='button']")].map((el) => el.textContent)).toEqual(["Try again"]);
      expect(doc.querySelector("[role='button']")?.classList.contains("bk-hit"), "Try again reaches under a coarse pointer").toBe(true);
    });

    test(`${list}: without onRetry there is no Try again`, () => {
      const doc = draw(element({}));
      expect(doc.querySelector("[data-google-failed]")?.textContent).toBe(`${failed}${detail}`);
      expect(doc.querySelectorAll("[role='button']"), "KIT_GOOGLE_RETRY_GATED").toHaveLength(0);
    });

    test(`${list}: a revoke error still shows its banner beside the failed state`, () => {
      const doc = draw(element({ error: "Couldn't revoke Archive." }));
      expect(doc.querySelector("[role='alert']")?.textContent).toBe("Couldn't revoke Archive.");
      expect(doc.querySelector("[data-google-failed]")).not.toBeNull();
    });
  }

  test("the allowance explainer keeps only its first sentence when the read failed", () => {
    expect(draw(<GoogleAllowanceList state="failed" grants={[grant("a", 84)]} onRevoke={noop} />).querySelector("p")?.textContent)
      .toBe("This chat is restricted, so remembered approvals are off.");
  });
});

describe("rows the host cannot show", () => {
  test("approvals: only unshown rows never read as none, and name the CLI that lists them", () => {
    const doc = draw(<GoogleApprovalList state="ready" accounts={[]} unshown={1} onRevoke={noop} />);
    expect(doc.body.textContent, "KIT_GOOGLE_UNSHOWN_NO_EMPTY").not.toContain(APPROVAL_EMPTY);
    const notice = doc.querySelector("[data-google-unshown]")!;
    expect(notice.getAttribute("data-google-unshown")).toBe("1");
    expect(notice.textContent, "KIT_GOOGLE_UNSHOWN_COPY").toBe("1 remembered approval can't be shown here. brain google approvals lists it.");
    expect(notice.querySelector("code")?.textContent, "the command is code").toBe("brain google approvals");
    expect(doc.querySelector("[role='alert']"), "the notice is not the revoke-error banner").toBeNull();
  });

  test("approvals: with rows, the notice follows them, and a revoke error shows beside it", () => {
    const doc = draw(<GoogleApprovalList state="ready" accounts={twoAccounts()} unshown={2} error="Couldn't revoke Archive." onRevoke={noop} />);
    expect(names(doc)).toHaveLength(3);
    const notice = doc.querySelector("[data-google-unshown]")!;
    expect(notice.textContent).toBe("2 remembered approvals can't be shown here. brain google approvals lists them.");
    const alert = doc.querySelector("[role='alert']")!;
    expect(alert.textContent, "KIT_GOOGLE_UNSHOWN_WITH_ERROR").toBe("Couldn't revoke Archive.");
    const rows = doc.querySelector(".bk-google-rows")!;
    expect(rows.compareDocumentPosition(notice) & 4, "the notice is after the rows").toBeTruthy();
    expect(notice.compareDocumentPosition(alert) & 4, "the banner is after the notice").toBeTruthy();
  });

  test("allowances: only unshown allowances never read as nothing allowed, and still apply", () => {
    const doc = draw(<GoogleAllowanceList state="ready" grants={[]} unshown={1} onRevoke={noop} />);
    expect(doc.body.textContent, "KIT_GOOGLE_UNSHOWN_NO_EMPTY").not.toContain(ALLOWANCE_EMPTY);
    expect(doc.querySelector("[data-google-unshown]")?.textContent, "KIT_GOOGLE_UNSHOWN_COPY").toBe("1 allowance in this chat can't be shown here. It still applies.");
    expect(doc.querySelector("p")?.textContent, "no row, so the explainer's lead alone").toBe("This chat is restricted, so remembered approvals are off.");
    const two = draw(<GoogleAllowanceList state="ready" grants={[grant("a", 84)]} unshown={2} error="Couldn't revoke Archive." onRevoke={noop} />);
    expect(two.querySelector("[data-google-unshown]")?.textContent).toBe("2 allowances in this chat can't be shown here. They still apply.");
    expect(two.querySelector("[role='alert']")?.textContent, "KIT_GOOGLE_UNSHOWN_WITH_ERROR").toBe("Couldn't revoke Archive.");
    expect(names(two)).toEqual(["Revoke Archive"]);
  });

  test("a zero, missing or not-a-number count is no notice; a fraction is still one", () => {
    for (const unshown of [0, undefined, Number.NaN, -2]) {
      const doc = draw(<GoogleApprovalList state="ready" accounts={[]} unshown={unshown} onRevoke={noop} />);
      expect(doc.querySelector("[data-google-unshown]"), `unshown ${unshown}`).toBeNull();
      expect(doc.body.textContent).toContain(APPROVAL_EMPTY);
    }
    const half = draw(<GoogleAllowanceList state="ready" grants={[]} unshown={0.5} onRevoke={noop} />);
    expect(half.querySelector("[data-google-unshown]")?.getAttribute("data-google-unshown")).toBe("1");
    expect(half.body.textContent).not.toContain(ALLOWANCE_EMPTY);
  });

  test("a count outside the ready state is not drawn", () => {
    for (const state of ["loading", "unavailable", "failed"] as const) {
      expect(draw(<GoogleApprovalList state={state} accounts={[]} unshown={2} onRevoke={noop} />).querySelector("[data-google-unshown]"), state).toBeNull();
      expect(draw(<GoogleAllowanceList state={state} grants={[]} unshown={2} onRevoke={noop} />).querySelector("[data-google-unshown]"), state).toBeNull();
    }
  });
});

describe("Try again, in a live tree", () => {
  const failedApprovals = (state: GoogleApprovalListProps["state"], onRetry?: () => void) => <GoogleApprovalList state={state} accounts={[]} onRevoke={noop} onRetry={onRetry} />;
  const failedAllowances = (state: GoogleAllowanceListProps["state"], onRetry?: () => void) => <GoogleAllowanceList state={state} grants={[]} onRevoke={noop} onRetry={onRetry} />;
  const retryButton = () => [...document.querySelectorAll<HTMLElement>("[role='button']")].find((el) => el.textContent === "Try again")!;

  for (const [list, element] of [["approval list", failedApprovals], ["allowance list", failedAllowances]] as const) {
    test(`${list}: Enter on Try again calls onRetry, and leaving the failed state hands focus to the heading`, async () => {
      let calls = 0;
      const onRetry = () => { calls++; };
      await render(element("failed", onRetry));
      await focus(retryButton());
      await act(async () => {
        retryButton().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
      });
      expect(calls, "KIT_GOOGLE_RETRY_CALLS").toBe(1);
      await render(element("loading", onRetry));
      expect(document.activeElement, "KIT_GOOGLE_RETRY_FOCUS_HEADING").toBe(heading());
      await render(element("failed", onRetry));
      expect(document.activeElement, "failing again leaves focus on the heading").toBe(heading());
    });

    test(`${list}: a retry fired while Try again did not hold focus moves focus nowhere`, async () => {
      let calls = 0;
      const onRetry = () => { calls++; };
      await render(element("failed", onRetry));
      expect(document.activeElement, "nothing holds focus").toBe(document.body);
      // A script's click: Try again never took focus.
      await act(async () => retryButton().click());
      expect(calls, "the retry still runs").toBe(1);
      await render(element("loading", onRetry));
      expect(document.querySelector("[aria-busy='true']"), "the list is reading").not.toBeNull();
      expect(document.activeElement, "KIT_GOOGLE_RETRY_FOCUS_ONLY_FROM_TRY_AGAIN").toBe(document.body);
    });

    test(`${list}: one polite status region for the list's whole life holds the failure, so failing again is announced and loading is not`, async () => {
      const region = () => {
        const all = document.querySelectorAll<HTMLElement>("[role='status']");
        expect(all.length, "one status region").toBe(1);
        return all[0]!;
      };
      await render(element("ready", noop));
      const first = region();
      expect(first.textContent, "empty while the list is not failed").toBe("");
      expect(first.getAttribute("aria-live"), "role=status: polite by its role, never assertive").toBeNull();
      expect(first.closest("[role='alert']"), "not an alert").toBeNull();
      await render(element("failed", noop));
      expect(region(), "KIT_GOOGLE_STATUS_PERSISTS").toBe(first);
      const words = first.textContent!;
      expect(words, "the failure is drawn inside the region").toMatch(/^Couldn't load .+\.Any you .+\.$/);
      expect(document.body.textContent!.split(words).length - 1, "KIT_GOOGLE_STATUS_ONCE: the words are drawn once, not copied for the region").toBe(1);
      expect(first.querySelector("[role='button']"), "Try again sits outside the region").toBeNull();
      await render(element("loading", noop));
      expect(region(), "KIT_GOOGLE_STATUS_PERSISTS").toBe(first);
      expect(first.textContent, "KIT_GOOGLE_STATUS_NOT_LOADING: loading says nothing").toBe("");
      expect(document.querySelector("[aria-busy='true']"), "the reading placeholder is drawn").not.toBeNull();
      expect(first.querySelector("[aria-busy]"), "outside the region").toBeNull();
      await render(element("failed", noop));
      expect(region(), "failing again changes the same region's text").toBe(first);
      expect(first.textContent).toBe(words);
    });

    test(`${list}: focus the user moved elsewhere after Try again stays there`, async () => {
      const outside = document.createElement("button");
      document.body.append(outside);
      try {
        await render(element("failed", noop));
        await focus(retryButton());
        await act(async () => retryButton().click());
        await focus(outside);
        await render(element("loading", noop));
        expect(document.activeElement).toBe(outside);
      } finally {
        outside.remove();
      }
    });
  }
});
