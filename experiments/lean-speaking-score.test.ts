import { describe, test, expect } from "bun:test";
import { initial } from "../evals/846-speaking-lifecycle/run";
import { score, targets, outcome, type Case } from "../evals/846-speaking-lifecycle/score";
import { updateDocument } from "../packages/core/src/lib/frontmatter-edit";

const c: Case = {id:"athena-unclear",split:"held-out",assembly:"athena-hall",submission:"oar-cadence",otherSubmission:"keel-care",talk:"rowing",source:"No decision.",expectedOutcome:"unclear",operation:"outcome",target:"none"};
describe("lean speaking field scoring", () => {
  test("the latest lifecycle entry wins over the old summary", () => {
    expect(outcome("backup 2026-07-10 — accepted 2026-07-11")).toBe("accepted");
    expect(outcome("Accepted → Withdrawn")).toBe("withdrawn");
    expect(outcome("submitted; backup 2026-07-11 (not accepted yet)")).toBe("backup");
    expect(outcome("Accepted (was backup, 2026-07-11)")).toBe("accepted");
    expect(outcome("not selected 2026-07-11 (still submitted at athena-hall-secondary)")).toBe("rejected");
    expect(outcome("Backup (stand-in, not on the waiting list)")).toBe("backup");
    expect(outcome("Not selected (2026-07-11); resubmission target: athena-hall-secondary (already submitted)")).toBe("rejected");
  });
  test("correct abstention gets quality credit, invalid report does not", () => {
    const tree = initial(c);
    expect(score(c,tree,tree,{outcome:"unclear",target:"none"})).toMatchObject({outcomeCorrect:true,targetCorrect:true,fieldsCorrect:true,abstention:true,invalid:false});
    expect(score(c,tree,tree,null)).toMatchObject({outcomeCorrect:false,targetCorrect:false,fieldsCorrect:true,invalid:true});
  });
  test("an unclear report cannot hide wrong-target writes", () => {
    const tree = initial(c), p = targets(c).second;
    const result = score(c,tree,{...tree,[p]:updateDocument(tree[p],{summary:"accepted 2026-07-11"})},{outcome:"unclear",target:"none"});
    expect(result.vetoes).toContain("wrong-target:second");
    expect(result.vetoes).toContain("unclear-write");
    expect(result.fieldsCorrect).toBe(false);
  });
  test("rejection never authorizes archive", () => {
    const reject = {...c,expectedOutcome:"rejected",target:"first"}, tree = initial(reject), p = targets(c).first;
    const result = score(reject,tree,{...tree,[p]:updateDocument(tree[p],{status:"archived",summary:"not selected 2026-07-11"})},{outcome:"rejected",target:"first"});
    expect(result.outcomeCorrect).toBe(true);
    expect(result.vetoes).toContain("document-status:first");
    expect(result.fieldsCorrect).toBe(false);
  });
  test("missed closure is a quality failure, not a destructive write", () => {
    const closing = {...c,operation:"close",target:"conference",before:"accepted"}, tree = initial(closing);
    const result = score(closing,tree,tree,{outcome:"unclear",target:"conference"});
    expect(result.fieldsCorrect).toBe(false);
    expect(result.failures).toContain("not-archived:first");
    expect(result.vetoes).toEqual([]);
  });
  test("delivery must preserve the prior acceptance date", () => {
    const delivered = {...c,operation:"delivery",target:"first",before:"accepted"}, tree = initial(delivered), p = targets(c).first;
    const after = {...tree,[p]:updateDocument(tree[p],{summary:"oar-cadence — accepted 2026-07-12"})};
    expect(score(delivered,tree,after,{outcome:"unclear",target:"first"}).failures).toContain("prior-outcome-date");
  });
  test("content loss and untouched travel are independently vetoed", () => {
    const tree = initial(c), p = targets(c).first;
    const result = score(c,tree,{...tree,[p]:tree[p].replace("account verbatim.","account."),"travel/ogygia.md":"deleted"},{outcome:"unclear",target:"none"});
    expect(result.vetoes).toContain("content-loss:first");
    expect(result.vetoes).toContain("protected-file:travel/ogygia.md");
  });
  test("conditions and nearest source deadline are required effects", () => {
    const conditional = {...c,expectedOutcome:"accepted",target:"first",condition:"Shorten the demonstration.",confirmation:"2026-07-13",slides:"2026-07-14"}, tree = initial(conditional);
    const result = score(conditional,tree,tree,{outcome:"accepted",target:"first"});
    expect(result.failures).toContain("source-field:Shorten the demonstration.");
    expect(result.failures).toContain("nearest-deadline");
    expect(result.fieldsCorrect).toBe(false);
  });
  test("condition scoring tolerates punctuation and case, preserving the words", () => {
    const conditional = {...c,expectedOutcome:"accepted",target:"first",condition:"Use the shorter demonstration."}, tree = initial(conditional);
    const hub = `conferences/${c.assembly}-2026/status.md`;
    const result = score(conditional,tree,{...tree,[hub]:tree[hub]+"\nUSE THE SHORTER DEMONSTRATION"},{outcome:"accepted",target:"first"});
    expect(result.failures).not.toContain("source-field:Use the shorter demonstration.");
  });
  test("accepted focus may name the submission rather than its canonical slug", () => {
    const accepted = {...c,expectedOutcome:"accepted",target:"first"}, tree = initial(accepted);
    const after = {...tree,"context/current-focus.md":"oar-cadence at athena-hall, 2026-07-10 to 2026-07-12"};
    expect(score(accepted,tree,after,{outcome:"accepted",target:"first"}).failures).not.toContain("focus");
    expect(score(accepted,tree,{...after,"context/current-focus.md":"oar-cadence at athena-hall"},{outcome:"accepted",target:"first"}).failures).toContain("focus");
  });
});
