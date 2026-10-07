import { expect, test } from "bun:test";
import { TurnObservation } from "../scripts/turn-surface-observation";
const model = "claude-sonnet-5-5";
function assistant(id: string, content: unknown[]) { return { type: "assistant", parent_tool_use_id: null,
  message: { id, model, usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 9 }, content } }; }
function result(id: string, is_error: boolean) { return { type: "user", parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content: "Controlled result" }] } }; }
test("actual successful tool results, not predictions or rejected calls, determine scores", () => {
  const observed = new TurnObservation(100, model);
  observed.observe(assistant("msg1", [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "fiction.md" } },
    { type: "tool_use", id: "skill", name: "Skill", input: { skill: "shipbuilding" } }]));
  observed.observe(result("read", true));
  observed.observe(result("skill", false));
  observed.observe({ type: "result", subtype: "success" });
  expect(observed.score({ neededToolGroups: [["Read"]], neededSkill: "voyage-plan" }))
    .toMatchObject({ included: true, neededToolsHit: false, neededSkillHit: false, wrongSkill: true });
  observed.observe(result("read", false));
  expect(observed.score({ neededToolGroups: [["Read"]], neededSkill: null }))
    .toMatchObject({ neededToolsHit: true, needlessSkill: true });
  expect(observed.score({ neededToolGroups: [], neededSkill: null })).toMatchObject({ needlessTool: true });
});
test("round trips deduplicate by native message id; missing results stay excluded", () => {
  const observed = new TurnObservation(100, model);
  observed.observe(assistant("msg1", []), 110); observed.observe(assistant("msg1", []), 115); observed.observe(assistant("msg2", []), 116);
  expect(observed.roundTrips.size).toBe(2);
  expect([...observed.roundTrips.values()][0]).toMatchObject({ inputTokens: 20, outputTokens: 7, cacheReadTokens: 8, cacheWriteTokens: 9 });
  expect(observed.score({ neededToolGroups: [], neededSkill: null }).included).toBe(false);
  observed.observe({ ...assistant("bad", []), parent_tool_use_id: "delegated" });
  expect(observed.roundTrips.size).toBe(2);
  observed.observe({ type: "stream_event", parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Fiction" } } }, 123);
  expect(observed.firstFrameMs).toBe(10); expect(observed.firstTextMs).toBe(23);
});
test("a successfully executed card with the wrong quote fails the content criterion", () => {
  const observed = new TurnObservation(0, model);
  observed.observe(assistant("quote", [{ type: "tool_use", id: "card", name: "mcp__brain-ui__show_block",
    input: { block: { kind: "quote", quote: "Inspect the mast." } } }]));
  observed.observe(result("card", false)); observed.observe({ type: "result", subtype: "success" });
  expect(observed.score({ neededToolGroups: [["mcp__brain-ui__show_block"]], neededSkill: null,
    contentChecks: { scope: "acceptedInputs", patterns: ["Keep the Bear on your left through the night"] } }))
    .toMatchObject({ neededToolsHit: true, contentPass: false });
});
