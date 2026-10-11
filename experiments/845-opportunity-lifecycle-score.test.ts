import { describe, expect, test } from "bun:test";
import { score, type Case } from "../evals/845-opportunity-lifecycle/score";
const corpus: { cases: Case[] } = await Bun.file(new URL("../evals/845-opportunity-lifecycle/cases.json", import.meta.url)).json();

const c = corpus.cases.find(c => c.id === "negated-booking")!;
const mapping = { kind: "none", opportunity: "none" };
describe("lean lifecycle scoring", () => {
  test("no-op allows derived pipeline refresh, but rejects content edits", () => {
    expect(score(c, c.files, mapping).exact).toBe(true);
    const after = { ...c.files, [`${c.directory}/_index.md`]: "regenerated view" };
    expect(score(c, after, mapping).exact).toBe(true);
    after[`${c.directory}/ithaca/status.md`] += "\nUnrequested change.\n";
    expect(score(c, after, mapping).exact).toBe(false);
  });
  test("wrong target veto is independent of mapping correctness", () => {
    const after = { ...c.files, [`${c.directory}/pylos/status.md`]: "wrong target" };
    expect(score(c, after, mapping).checks.mapping).toBe(true);
    expect(score(c, after, mapping).vetoes).toContain("wrong-opportunity");
  });
  test("timeline and prep losses remain visible separately", () => {
    const prep = `${c.directory}/${c.target}/interview-prep.md`;
    const before = { ...c.files, [prep]: "## Positioning\n\nOdysseus keeps this story.\n" };
    const after = { ...before, [prep]: "## Positioning\n", [`${c.directory}/${c.target}/status.md`]: before[`${c.directory}/${c.target}/status.md`].replace("- 2026-07-12: application recorded.", "") };
    const result = score({ ...c, files: before }, after, mapping);
    expect(result.vetoes).toContain("prep-content-loss");
    expect(result.vetoes).toContain("timeline-or-content-loss");
    expect(result.exact).toBe(false);
  });
  test("correct frontmatter cannot hide an obsolete call or pipeline row", () => {
    const booked = corpus.cases.find(c => c.id === "single-screen-0")!;
    const prefix = `${booked.directory}/ithaca/`, call = booked.expected.calls[0];
    const after = { ...booked.files,
      [`${prefix}status.md`]: booked.files[`${prefix}status.md`].replace("stage: applied", `stage: interviewing\nnext_step: ${JSON.stringify(call)}\ndeadline: 2026-07-20`).replace("|------|------|--------------|-------|", "|------|------|--------------|-------|\n| Mentor | Stewardship | Interview | unknown |") + `\n- 2026-07-12: ${call}\n[[${prefix}interview-prep]]\n`,
      [`${prefix}interview-prep.md`]: `---\ndeadline: 2026-07-20\n---\n\n## The call\n\n${call}\n\n## Related\n\n[[${prefix}status]]\n[[${prefix}research]]\n`,
      [booked.focusPath]: booked.files[booked.focusPath].replace("Waiting to hear back.", call),
      [`${booked.directory}/_index.md`]: `| [[${prefix}status]] | interviewing | — | ${call} | 2026-07-20 | 2026-07-12 |`,
    };
    const applied = { kind: "scheduled", opportunity: "ithaca" };
    expect(score(booked, after, applied).exact).toBe(true);
    const wording = { ...after, [`${prefix}status.md`]: after[`${prefix}status.md`].replace("| Mentor | Stewardship | Interview | unknown |", "- **Mentor**; contact details unknown."), [`${prefix}interview-prep.md`]: after[`${prefix}interview-prep.md`].replace("deadline: 2026-07-20", "title: Screening preparation\ndeadline: 2026-07-20").replace(call, "Mentor, 20 July 9:00 UTC; video, 30 min") };
    expect(score(booked, wording, applied).exact).toBe(true);
    expect(score(booked, { ...wording, [`${prefix}interview-prep.md`]: wording[`${prefix}interview-prep.md`].replace("30 min", "60 min") }, applied).checks.calls).toBe(false);
    expect(score(booked, { ...after, [`${prefix}status.md`]: after[`${prefix}status.md`].replace("| Mentor | Stewardship | Interview | unknown |", "") }, applied).checks.contacts).toBe(false);
    expect(score(booked, { ...after, [`${prefix}interview-prep.md`]: after[`${prefix}interview-prep.md`].replace("2026-07-20T", "2026-07-19T") }, applied).checks.calls).toBe(false);
    expect(score(booked, { ...after, [`${prefix}status.md`]: after[`${prefix}status.md`].replace("09:00", "10:00") }, applied).checks.nextStep).toBe(false);
    expect(score(booked, { ...after, [`${booked.directory}/_index.md`]: after[`${booked.directory}/_index.md`].replaceAll("2026-07-20", "2026-07-19") }, applied).checks.pipeline).toBe(false);
  });
});
