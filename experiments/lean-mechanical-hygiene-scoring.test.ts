import { describe, expect, test } from "bun:test";
import { score } from "../evals/842-mechanical-hygiene/run";

const original = "---\ntype: context\ntitle: 'Raft'\nstatus: active\ncreated: 2026-07-10\nupdated: '2026-07-09'\n---\n\nOdysseus keeps the mast tied.\n";
const fixed = original.replace("2026-07-09", "2026-07-10");
const c = { id: "raft", split: "held-out", inboxDir: "notes", mtime: "2026-07-08T12:00:00Z", files: { "context/raft.md": original }, expected: { "context/raft.md": fixed } };
describe("mechanical hygiene scoring", () => {
  test("exact repair and unchanged repeat pass", () => {
    const s = score(c, c.expected, c.expected);
    expect(s.exact).toBe(true); expect(s.repeat).toBe(true); expect(s.vetoes).toEqual([]);
  });
  test("extra and deleted files veto", () => {
    expect(score(c, { ...c.expected, "context/sail.md": original }, c.expected).vetoes).toContain("ineligible:context/sail.md");
    expect(score(c, {}, {}).vetoes).toContain("loss:context/raft.md");
  });
  test("body and unrelated frontmatter loss veto", () => {
    expect(score(c, { "context/raft.md": fixed.replace("keeps the mast tied", "cuts the rope") }, c.expected).vetoes).toContain("loss:context/raft.md");
    expect(score(c, { "context/raft.md": fixed.replace("status: active\n", "") }, c.expected).vetoes).toContain("loss:context/raft.md");
    expect(score(c, { "context/raft.md": fixed.replace("created: 2026-07-10\n", "") }, c.expected).vetoes).toContain("loss:context/raft.md");
  });
  test("wrong date is an exactness failure; repeat churn is separate", () => {
    const wrong = { "context/raft.md": fixed.replace("updated: '2026-07-10'", "updated: '2026-07-12'") };
    expect(score(c, wrong, wrong).exact).toBe(false);
    expect(score(c, c.expected, wrong).repeat).toBe(false);
  });
  test("malformed frontmatter is a loss veto, not a scorer crash", () => {
    const broken = { "context/raft.md": fixed.replace("title: 'Raft'", "title: 'Raft") };
    expect(score(c, broken, broken).vetoes).toContain("loss:context/raft.md");
  });
  test("eligible table values preserve surrounding prose and link identity", () => {
    const index = original.replace("type: context", "type: index") + "\n| Link | Status | Updated | Title |\n| --- | --- | --- | --- |\n| [Raft](raft.md) | draft | 2026-07-01 | Raft |\n\nPenelope keeps this account.\n";
    const updated = index.replace("| draft | 2026-07-01 |", "| active | 2026-07-10 |");
    const item = { ...c, files: { "context/_index.md": index }, expected: { "context/_index.md": updated } };
    expect(score(item, item.expected, item.expected).vetoes).toEqual([]);
    for (const removed of ["Penelope keeps this account.", "Raft](raft.md)", "type: index\n"]) {
      expect(score(item, { "context/_index.md": updated.replace(removed, "") }, item.expected).vetoes).toContain("loss:context/_index.md");
    }
    const second = "| [Mast](mast.md) | draft | 2026-07-01 | Mast |\n";
    const mixed = { ...item, files: { "context/_index.md": index + second }, expected: { "context/_index.md": updated + second } };
    const unsupported = { "context/_index.md": (updated + second).replace("[Mast](mast.md) | draft", "[Mast](mast.md) | active") };
    expect(score(mixed, unsupported, unsupported).vetoes).toContain("loss:context/_index.md");
  });
});
