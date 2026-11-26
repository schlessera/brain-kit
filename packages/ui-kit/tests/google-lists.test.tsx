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
    [{ kind: "label", labelId: "Label_12", labelName: "Voyage" }, "Add label Voyage"],
    [{ kind: "unlabel", labelId: "Label_7", labelName: "Suitors" }, "Remove label Suitors"],
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
    const withheld = draw(<GoogleApprovalList state="ready" accounts={[{ address: ODYSSEUS, approvals: [{ id: "a", action: { kind: "label", labelId: "Label_7", labelName: null }, since: SAT }] }]} onRevoke={noop} />);
    expect(withheld.querySelector("bdi")).toBeNull();
    expect(withheld.querySelector("[data-google-label-id]")?.textContent).toBe("Label_7");
    expect(names(withheld)).toEqual([`Revoke Add label Label_7 for ${ODYSSEUS}`]);
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
    expect(one.querySelector("[data-google-grant]")?.textContent).toContain("Archive · Mark as read · Add label Voyage");
    expect(names(one)).toEqual(["Revoke Archive, Mark as read and Add label Voyage"]);
    expect(one.body.textContent, "one account: no address").not.toContain(ODYSSEUS);
    const button = one.querySelector("[role='button']")!;
    expect(one.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("until Sunday 12 July 2026 at 18:02");

    const two = draw(<GoogleAllowanceList state="ready" grants={[grant("a", 84, ODYSSEUS, actions.slice(0, 2)), grant("b", 40, PENELOPE, [{ kind: "drafts" }])]} onRevoke={noop} />);
    expect(two.body.textContent).toContain(ODYSSEUS);
    expect(two.body.textContent).toContain(PENELOPE);
    expect(names(two)).toEqual([`Revoke Archive and Mark as read for ${ODYSSEUS}`, `Revoke Save drafts for ${PENELOPE}`]);
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
