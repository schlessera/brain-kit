/**
 * `TrackerPillList` (#1001) as markup: what it derives from each url, the
 * tone table, the runs, the accessible names and the withheld pill. What only
 * a layout engine can answer (one line at 320px, the 44px rows, truncation,
 * the host wrapping only after a dot, contrast on the tints) is
 * `tests/visual/tracker-pills.visual.tsx`'s.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TrackerPillList,
  shortQualifier,
  trackerItem,
  trackerRuns,
  trackerTone,
  type TrackerEvent,
} from "../src/blocks/TrackerPillList.js";
import { trackerEveryAction, trackerMixed, trackerTwenty } from "../fixtures/tracker.js";

function draw(events: readonly TrackerEvent[], expanded?: boolean): Document {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(<TrackerPillList events={events} expanded={expanded} />);
  return document as unknown as Document;
}

describe("trackerItem: identity comes from the url alone", () => {
  test("a github.com issue or pull request gives its repository, number and type", () => {
    expect(trackerItem("https://github.com/ithaca/hall/issues/12")).toEqual({
      ok: true,
      href: "https://github.com/ithaca/hall/issues/12",
      host: "github.com",
      github: { repo: "ithaca/hall", number: 12, type: "issue" },
    });
    const pull = trackerItem("https://github.com/ithaca/pylos-voyage/pull/21/files?w=1#diff");
    expect(pull.ok && pull.github).toEqual({ repo: "ithaca/pylos-voyage", number: 21, type: "pull" });
  });

  test("anything that is not exactly that shape yields the host and nothing else", () => {
    for (const url of [
      "https://tracker.ogygia-shipyard.example/ithaca/hall/issues/12",
      "https://www.github.com/ithaca/hall/issues/12",
      "https://github.com:8443/ithaca/hall/issues/12",
      "https://github.com/ithaca/hall/discussions/12",
      "https://github.com/ithaca/hall/issues/012",
      "https://github.com/ithaca/hall/issues",
      "https://github.com/ithaca/../issues/12",
      "https://github.com/-ithaca/hall/issues/12",
    ]) {
      const item = trackerItem(url);
      expect(item.ok).toBe(true);
      expect(item.ok && item.github).toBeUndefined();
    }
  });

  test("a refused address is the policy's refusal", () => {
    const item = trackerItem("https://odysseus:nobody@github.com/ithaca/hall/issues/14");
    expect(item.ok).toBe(false);
    expect(!item.ok && item.reason).toBe("credentials");
  });
});

describe("trackerTone: the approved table", () => {
  test("every action and qualifier draws its tone", () => {
    const table: [TrackerEvent["action"], string | undefined, string][] = [
      ["merged", undefined, "teal"],
      ["closed", "completed", "teal"],
      ["closed", "COMPLETED", "teal"],
      ["closed", "not planned", "neutral"],
      ["closed", "not_planned", "neutral"],
      ["closed", "duplicate", "neutral"],
      ["closed", undefined, "neutral"],
      ["opened", undefined, "amber"],
      ["reopened", undefined, "gold"],
      ["labeled", "household", "neutral"],
      ["commented", undefined, "neutral"],
      ["reviewed", "approved", "teal"],
      ["reviewed", "CHANGES_REQUESTED", "gold"],
      ["reviewed", "changes requested", "gold"],
      ["reviewed", "commented", "neutral"],
      ["reviewed", undefined, "neutral"],
    ];
    for (const [action, qualifier, tone] of table) expect([action, qualifier, trackerTone(action, qualifier)]).toEqual([action, qualifier, tone]);
  });

  test("each pill carries its tone and prints its action as a word", () => {
    const doc = draw(trackerEveryAction, true);
    const pills = [...doc.querySelectorAll("[data-tracker-pill]")];
    expect(pills).toHaveLength(trackerEveryAction.length);
    pills.forEach((pill, i) => {
      const event = trackerEveryAction[i]!;
      expect(pill.getAttribute("data-tone")).toBe(trackerTone(event.action, event.qualifier));
      expect(pill.querySelector("[data-tracker-action]")!.textContent).toStartWith(event.action);
    });
  });
});

describe("the qualifier", () => {
  test("is drawn whole up to 16 characters, then cut with an ellipsis", () => {
    expect(shortQualifier("changes requested")).toBe("changes requeste…");
    expect(shortQualifier("not planned")).toBe("not planned");
    expect(shortQualifier("a".repeat(16))).toBe("a".repeat(16));
  });
});

describe("runs", () => {
  test("consecutive same host and repository share a header; a change starts one; order is kept", () => {
    const runs = trackerRuns(trackerMixed);
    expect(runs.map((run) => [run.header, run.rows.map((row) => row.index)])).toEqual([
      [{ host: "github.com", repo: "ithaca/hall" }, [0, 1, 2, 3]],
      [{ host: "tracker.ogygia-shipyard.example" }, [4]],
    ]);
  });

  test("a withheld event first has no header; one that follows a run joins it", () => {
    const withheld = trackerMixed[3]!;
    const runs = trackerRuns([withheld, trackerMixed[0]!, withheld]);
    expect(runs.map((run) => [run.header, run.rows.map((row) => row.index)])).toEqual([
      [null, [0]],
      [{ host: "github.com", repo: "ithaca/hall" }, [1, 2]],
    ]);
  });

  test("a run header names the derived host and repository, and labels its list", () => {
    const doc = draw(trackerMixed);
    const headers = [...doc.querySelectorAll("[data-tracker-run]")];
    expect(headers.map((h) => h.textContent)).toEqual(["github.com · ithaca/hall", "tracker.ogygia-shipyard.example"]);
    for (const header of headers) {
      expect(doc.querySelector(`ul[aria-labelledby="${header.id}"]`)).not.toBeNull();
    }
  });
});

describe("a pill", () => {
  test("is an anchor to the parsed href, in a new tab, with no opener and no referrer", () => {
    const doc = draw(trackerMixed);
    const anchors = [...doc.querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/ithaca/hall/issues/12",
      "https://github.com/ithaca/hall/pull/21",
      "https://github.com/ithaca/hall/issues/9",
      "https://tracker.ogygia-shipyard.example/tickets/4",
    ]);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")!.split(" ").sort()).toEqual(["nofollow", "noopener", "noreferrer"]);
      expect(a.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(a.querySelector("[data-tracker-open]")!.textContent).toBe("↗");
    }
  });

  test("prints `#n` for an issue, `PR n` for a pull request, and no number off GitHub", () => {
    const doc = draw(trackerMixed);
    const numbers = [...doc.querySelectorAll("a")].map((a) => a.querySelector("[data-tracker-number]")?.textContent ?? null);
    expect(numbers).toEqual(["#12", "PR 21", "#9", null]);
  });

  test("is named from derived fields; the title is only its description", () => {
    const doc = draw(trackerMixed);
    const anchors = [...doc.querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Open issue ithaca/hall 12 on github.com, opened",
      "Open pull request ithaca/hall 21 on github.com, merged",
      "Open issue ithaca/hall 9 on github.com, closed, not planned",
      "Open tracker.ogygia-shipyard.example, opened",
    ]);
    for (const [i, a] of anchors.entries()) {
      const title = [0, 1, 2, 4].map((n) => trackerMixed[n]!.title)[i]!;
      expect(a.getAttribute("aria-label")).not.toContain(title);
      const description = doc.getElementById(a.getAttribute("aria-describedby")!)!;
      expect(description.textContent).toBe(`Title by the brain: ${title}`);
    }
  });

  test("carries the whole qualifier in its name when the drawn one is cut", () => {
    const doc = draw([{ url: "https://github.com/ithaca/hall/pull/23", action: "reviewed", qualifier: "changes requested", title: "Bar the hall doors" }]);
    expect(doc.querySelector("a")!.getAttribute("aria-label")).toBe(
      "Open pull request ithaca/hall 23 on github.com, reviewed, changes requested"
    );
    expect(doc.querySelector("[data-tracker-action]")!.textContent).toBe("reviewed changes requeste…");
  });
});

describe("the withheld pill", () => {
  test("is text, not a link: no anchor, no tab stop, no open glyph, and its reason is in the foot", () => {
    const doc = draw(trackerMixed);
    const withheld = doc.querySelector("[data-tracker-withheld]")!;
    expect(withheld.querySelector("a, [tabindex], button")).toBeNull();
    expect(withheld.querySelector("[data-tracker-open]")).toBeNull();
    expect(withheld.textContent).toContain("withheld");
    expect(withheld.textContent).toContain("Withheld link, address refused. Title by the brain: Raft repair estimate");
    expect(doc.body.textContent).not.toContain("odysseus:nobody");
    expect([...doc.querySelectorAll("[data-tracker-refusal]")].map((p) => p.textContent)).toEqual([
      "1 address withheld: the address carries a sign-in name or password.",
    ]);
  });
});

describe("the list", () => {
  test("states its count and always carries the honesty line", () => {
    for (const events of [trackerMixed, trackerEveryAction.slice(0, 1)]) {
      const doc = draw(events);
      expect(doc.querySelector("section")!.getAttribute("aria-label")).toBe(`Tracker changes, ${events.length}`);
      expect(doc.querySelector("[data-tracker-honesty]")!.textContent).toBe(
        "Changes as reported by the brain · tracker not checked"
      );
    }
    expect(draw(trackerEveryAction.slice(0, 1)).body.textContent).toContain("Tracker · 1 change");
    expect(draw(trackerMixed).querySelector("[data-tracker-refusal]")).not.toBeNull();
    expect(draw(trackerEveryAction).querySelector("[data-tracker-refusal]")).toBeNull();
  });

  test("past 6 events shows 5 and a Show all control; expanded, all of them after it", () => {
    const collapsed = draw(trackerTwenty);
    expect(collapsed.querySelectorAll("[data-tracker-pill]")).toHaveLength(5);
    const more = collapsed.querySelector("[data-tracker-more]")!;
    expect(more.textContent).toBe("Show all 20 changes");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(collapsed.body.textContent).toContain("Tracker · 20 changes");

    const open = draw(trackerTwenty, true);
    const pills = [...open.querySelectorAll("[data-tracker-pill]")];
    expect(pills.map((a) => a.getAttribute("href"))).toEqual(trackerTwenty.map((e) => e.url));
    const control = open.querySelector("[data-tracker-more]")!;
    expect(control.textContent).toBe("Show fewer");
    // The control stays where it was: five pills before it, fifteen after.
    const order = [...open.querySelectorAll("[data-tracker-pill], [data-tracker-more]")];
    expect(order.indexOf(control)).toBe(5);
    // The run that continues past the control is labelled by its own header,
    // which is drawn once.
    expect([...open.querySelectorAll("[data-tracker-run]")].map((h) => h.textContent)).toEqual([
      "github.com · ithaca/hall",
      "github.com · ithaca/pylos-voyage",
    ]);
  });

  test("exactly 6 events show all 6 and no control", () => {
    const doc = draw(trackerEveryAction.slice(0, 6));
    expect(doc.querySelectorAll("[data-tracker-pill]")).toHaveLength(6);
    expect(doc.querySelector("[data-tracker-more]")).toBeNull();
  });
});
