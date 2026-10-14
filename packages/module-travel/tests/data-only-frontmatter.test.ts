import { expect, test } from "bun:test";
import { frontmatterEngineSentinel } from "../../../tests/helpers/frontmatter-engine-sentinel";
import { parseTravelDocument } from "../src/content";

test("travel keeps its intentional YAML engine and refuses delimiter-selected engines", () => {
  const sentinel = frontmatterEngineSentinel();
  try {
    for (const language of ["js", "javascript", "JS", "json", "odyssey"]) {
      expect(() => parseTravelDocument(`---${language}\nOdysseus\n---\n`)).toThrow("use YAML data only");
      expect(sentinel.dispatched, "TRAVEL_NO_ENGINE_DISPATCH").toEqual([]);
    }
    const parsed = parseTravelDocument("---yml\ntitle: Return to Ithaca\ntype: travel\nvisits: [{id: ithaca, date: 2026-07-12}]\n---\n");
    expect(parsed).toMatchObject({ visits: [{ date: "2026-07-12" }] });
  } finally { sentinel.restore(); }
});
