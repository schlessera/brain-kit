import { expect, test } from "bun:test";
import { admitExactPackets, type ReviewReceipt } from "../scripts/evals/canonical-conflicts/review-packet";

test("combined exact-packet admission rejects mixed prompts, duplicate subsets and incomplete native evidence", () => {
  const expected = [{ key: "cases-1", freezeSha: "same-freeze", promptSha: "exact-prompt-a" }, { key: "cases-2", freezeSha: "same-freeze", promptSha: "exact-prompt-b" }];
  const receipts: ReviewReceipt[] = expected.map(p => ({ ...p, approved: true, model: "claude-sonnet-5-5", actualCli: "2.1.293",
    finished: true, drained: true, stdoutComplete: true, callsComplete: true, overage: "inactive observed", actualProvider: true,
    scope: "complementary-semantic-review", authorFamily: "gpt", reviewerFamily: "claude" }));
  expect(admitExactPackets(expected, receipts)).toBe(true);
  expect(admitExactPackets(expected, [{ ...receipts[0]!, promptSha: "older-payload-same-freeze" }, receipts[1]!])).toBe(false);
  expect(admitExactPackets(expected, [receipts[0]!, receipts[0]!])).toBe(false);
  for (const change of [{ approved: false }, { drained: false }, { stdoutComplete: false }, { callsComplete: false }, { overage: "active" },
    { actualProvider: false }, { scope: "offline-control" }, { authorFamily: "claude" }, { reviewerFamily: "gpt" }, { actualCli: "2.1.283" }])
    expect(admitExactPackets(expected, [{ ...receipts[0]!, ...change }, receipts[1]!])).toBe(false);
});
