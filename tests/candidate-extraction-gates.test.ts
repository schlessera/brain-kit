import { expect, test } from "bun:test";
import { prepare, jobResearch, conferenceResearch, submissionReview } from "../scripts/evals/candidate-extraction/prototype";
import { scriptedResult } from "../scripts/evals/candidate-extraction/run";
test("actual research consumer refuses low selected probability even at high confidence", async () => {
  const p = prepare("Salary EUR 120,000–140,000 per year.", "job");
  const c = p.candidates.find(c => c.kind === "money")!;
  const result = await scriptedResult(p, { salary: String(c.index) }, raw => {
    const answers = raw.answers as Record<string, { confidence: number; probabilities: Record<string, number> }>;
    answers.salary.confidence = 0.99;
    answers.salary.probabilities = { [String(c.index)]: 0.2, none: 0.8, unclear: 0 };
  });
  expect(result.outcome).toBe("answered");
  const report = jobResearch(p, result);
  expect(report.fields.salary!.status).toBe("unresolved");
  expect(report.automaticOpportunityWrite).toBe(false);
});
test("explicit null field gates remain unresolved in both research and submission consumers",async()=>{
  const p=prepare("Bio 120 code points. Talk 30 minutes. Deadline 2028-07-01.","cfp");
  expect(p.candidates).toHaveLength(3);
  const selected=Object.fromEntries(p.candidates.map(c=>[c.kind==="date"?"deadline":c.kind==="limit"?"bio_limit":"talk_duration",String(c.index)]));
  const result=await scriptedResult(p,selected);
  expect(result.outcome).toBe("answered");
  expect(conferenceResearch(p,result).fields.deadline!.status).toBe("selected");
  expect(submissionReview(p,result,"Odysseus",["30 minutes"]).readyForUserReview).toBe(true);
  expect(conferenceResearch(p,result,{}).fields.deadline!.status).toBe("unresolved");
  expect(submissionReview(p,result,"Odysseus",["30 minutes"],{}).readyForUserReview).toBe(false);
});
