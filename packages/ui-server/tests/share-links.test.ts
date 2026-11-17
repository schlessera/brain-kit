import { expect, test } from "bun:test";
import { markdownLinkTargets, resolveLinkTarget } from "../src/inbox/share-links.js";

test("link destinations resolve from the linking document's folder", () => {
  const note = "voyages/ithaca/harbor.md";
  expect(resolveLinkTarget(note, "../../assets/documents/ithaca.pdf")).toBe("assets/documents/ithaca.pdf");
  expect(resolveLinkTarget(note, "./../../assets/ithaca.pdf")).toBe("assets/ithaca.pdf");
  expect(resolveLinkTarget(note, "/assets/ithaca.pdf")).toBe("assets/ithaca.pdf");
  expect(resolveLinkTarget(note, "assets/ithaca.pdf")).toBe("voyages/ithaca/assets/ithaca.pdf");
  expect(resolveLinkTarget("telemachus.md", "assets/ithaca.pdf")).toBe("assets/ithaca.pdf");
  expect(resolveLinkTarget(note, "../../assets/ithaca%20harbor.pdf#page=2")).toBe("assets/ithaca harbor.pdf");
  expect(resolveLinkTarget(note, "<../../assets/ithaca harbor.pdf>")).toBe("assets/ithaca harbor.pdf");
  expect(resolveLinkTarget(note, "../../../assets/ithaca.pdf"), "ESCAPING_THE_BRAIN_RESOLVES_NOTHING").toBeNull();
  expect(resolveLinkTarget(note, "https://example.org/assets/ithaca.pdf")).toBeNull();
  expect(resolveLinkTarget(note, "//example.org/assets/ithaca.pdf")).toBeNull();
  expect(resolveLinkTarget(note, "../../assets/%E0%A4%A.pdf"), "MALFORMED_ENCODING_RESOLVES_NOTHING").toBeNull();
});

test("inline links, images, titles and reference definitions count; code spans, fences and wiki-links do not", () => {
  const targets = (content: string) => [...markdownLinkTargets("voyages/ithaca/harbor.md", content)].sort();
  expect(targets([
    "[Confirmation](../../assets/a.pdf) ![Map](/assets/b.png \"Ithaca\")",
    "[Loom][c]",
    "[c]: ../../assets/c.pdf",
  ].join("\n"))).toEqual(["assets/a.pdf", "assets/b.png", "assets/c.pdf"]);
  expect(targets([
    "`[Confirmation](../../assets/a.pdf)` ``[Two](../../assets/b.pdf)``",
    "```markdown",
    "[Fenced](../../assets/c.pdf)",
    "```",
    "~~~~",
    "[Tilde](../../assets/d.pdf)",
    "~~~",
    "~~~~",
    "[[assets/e.pdf]] ![[e.pdf]]",
  ].join("\n"))).toEqual([]);
});
