/** Raw serialization checks with literal entry plans; writer/CLI proof stays in tags.test.ts. */
import { expect, test } from "bun:test";
import { rewriteTags } from "../src/lib/tags-apply";

const doc = (tags: string) => `---\ntitle: D\ntype: note\ntags: ${tags}\n---\n\nbody\n`;

test("a block list with comments comes out byte-identical except the tag entries", () => {
  const before = [
    "---",
    "# Owner's note: keep this line",
    'title: "Quoted title"  # an inline comment',
    "type: note",
    "updated: 2026-01-05",
    "tags:",
    "  # route work",
    "  - routes   # renamed",
    "  - 'sailing'",
    "  - route",
    "  - ship_building",
    "aliases: [one,two]",
    "---",
    "",
    "tags: [routes] in the body stays",
    "",
  ].join("\n");
  const result = rewriteTags(before, () => ["route", "sailing", null, "shipbuilding"]);
  expect(result).toEqual({
    from: ["routes", "sailing", "route", "ship_building"],
    to: ["route", "sailing", "shipbuilding"],
    text: before.replace("  - routes   # renamed", "  - route   # renamed").replace("  - route\n", "").replace("  - ship_building", "  - shipbuilding"),
  });
});

test("flow sequences keep their quoting and separator, and a new tag is quoted when YAML would retype it", () => {
  expect(rewriteTags('---\ntitle: T\ntype: note\ntags: ["legacy",old,\'x y\'] # trailing\n---\n', () => ["kept", "2026", "x y"])).toEqual({
    text: '---\ntitle: T\ntype: note\ntags: [kept,"2026",\'x y\'] # trailing\n---\n',
    from: ["legacy", "old", "x y"], to: ["kept", "2026", "x y"],
  });
});

test("a byte order mark before the frontmatter stays, and the tags still migrate", () => {
  const bom = "\uFEFF---\ntitle: B\ntype: note\ntags: [routes]\n---\nbody\n";
  expect(rewriteTags(bom, () => ["route"])).toEqual({ text: bom.replace("[routes]", "[route]"), from: ["routes"], to: ["route"] });
});

test("CRLF files keep their line endings", () => {
  const crlf = "---\r\ntitle: C\r\ntype: note\r\ntags:\r\n  - routes\r\n  - sailing\r\n---\r\nbody\r\n";
  expect(rewriteTags(crlf, () => ["route", "sailing"])).toEqual({ text: crlf.replace("- routes", "- route"), from: ["routes", "sailing"], to: ["route", "sailing"] });
});

test("a flow sequence keeps the gaps around untouched entries, commas in quotes included", () => {
  expect(rewriteTags(doc("[ routes,  sailing ,navigation, ]"), () => ["route", "sailing", "navigation"])).toEqual({
    text: doc("[ route,  sailing ,navigation, ]"), from: ["routes", "sailing", "navigation"], to: ["route", "sailing", "navigation"],
  });
  expect(rewriteTags(doc('["x, y", routes,sailing]'), () => ["x, y", "route", "sailing"])).toEqual({
    text: doc('["x, y", route,sailing]'), from: ["x, y", "routes", "sailing"], to: ["x, y", "route", "sailing"],
  });
  expect(rewriteTags(doc("[ routes,  sailing ,route, ]"), () => ["route", "sailing", null])).toEqual({
    text: doc("[ route,  sailing, ]"), from: ["routes", "sailing", "route"], to: ["route", "sailing"],
  });
});

test("a dropped block entry's comment stays as a comment line", () => {
  const before = "---\ntitle: D\ntype: note\ntags:\n  - routes\n  - route # preserve me\n  - sailing\n---\n";
  expect(rewriteTags(before, () => ["route", null, "sailing"])).toEqual({
    text: "---\ntitle: D\ntype: note\ntags:\n  - route\n  # preserve me\n  - sailing\n---\n",
    from: ["routes", "route", "sailing"], to: ["route", "sailing"],
  });
});

test("a rewrite that would not read back as the planned tags is refused", () => {
  expect(rewriteTags(doc("[old, sailing]"), () => ["2026-01-05", "sailing"])).toEqual({
    skip: "the rewrite did not read back as the planned tags",
  });
});
