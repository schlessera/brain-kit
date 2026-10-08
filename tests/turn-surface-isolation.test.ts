import { expect, test } from "bun:test";
import { captureSurface } from "../scripts/capture-turn-surface";
import { routingMeasurementHook } from "../scripts/turn-surface-isolation";
import type { MeasurementToolAccess } from "../scripts/measurement-isolation";
import { TurnObservation } from "../scripts/turn-surface-observation";

test("installed routing CLI denies outside Read before execution and admits the fixture Read", async () => {
  const decision = Promise.resolve({ arm: "baseline" as const, routed: false, tools: [], skills: [] });
  const audit: MeasurementToolAccess[] = [];
  const capture = await captureSurface({ decision, readGuardControl: true,
    guard: root => routingMeasurementHook(root, ["voyage-plan"], decision, audit) });
  expect(capture.requests).toHaveLength(3);
  const last = JSON.stringify(capture.requests[2]!.messages);
  expect(last).not.toContain("OUTSIDE CONTROLLED CONTENT MUST NEVER REACH THE MODEL");
  expect(last).toContain("Live measurement tools may only read the staged fictional fixture brain");
  expect(last).toContain("Odysseus is preparing the next voyage");
  expect(audit).toEqual([
    { tool: "Read", allowed: false, target: "outside-or-unproved" },
    { tool: "Read", allowed: true, target: "me/identity.md" },
  ]);
  const observed = new TurnObservation(performance.now(), "claude-sonnet-5-5");
  for (const frame of capture.frames) observed.observe(frame);
  expect([...observed.calls.values()].map(call => ({ name: call.name, accepted: call.accepted })))
    .toEqual([{ name: "Read", accepted: false }, { name: "Read", accepted: true }]);
  expect(observed.roundTrips.size).toBe(3);
  expect(observed.score({ neededToolGroups: [["Read"]], neededSkill: null }).neededToolsHit).toBe(true);
  expect(capture.rawFrames.find(frame => frame.type === "result")?.subtype).toBe("success");
  expect(capture.rawFrames.some(frame => frame.type === "control_response")).toBe(true);
});
