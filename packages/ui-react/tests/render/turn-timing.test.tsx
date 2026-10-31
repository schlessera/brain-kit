import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { TurnTiming } from "../../src/components/activity/turn-timing.js";

function mount(lifecycle?: ActivityTurnLifecycle) {
  const host = new Window().document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<TurnTiming lifecycle={lifecycle} />);
  return host;
}
const fixture = (over: Partial<ActivityTurnLifecycle>): ActivityTurnLifecycle => ({
  hostEvents: [], skippedPhases: [],lifecycleId:"lifecycle:turn-ithaca",turnId:"turn-ithaca",sessionId:"ithaca",backendRunId:"turn-ithaca",acceptedAt:1000,dequeuedAt:null,
  governedStartedAt:1000,governedAcquiredAt:2000,budgetStartedAt:2000,budgetAdmittedAt:3000,
  journalStartedAt:3000,journalBeganAt:4000,backendInvokedAt:4000,firstFrameAt:6000,failureObservedAt:null,endedAt:10000,
  outcome:"success",reason:null,totalElapsedMs:9000,timeToFirstFrameMs:5000,queueWaitMs:null,
  governedAdmissionMs:1000,budgetAdmissionMs:1000,journalBeginMs:1000,backendStartupMs:2000,...over,
});
test("refused admission shows actual incomplete time without inventing backend execution",()=>{
  const node=mount(fixture({outcome:"denied",reason:"Admission refused",backendRunId:null,firstFrameAt:null,
    timeToFirstFrameMs:null,budgetStartedAt:null,budgetAdmittedAt:null,budgetAdmissionMs:null,
    journalStartedAt:null,journalBeganAt:null,journalBeginMs:null,backendInvokedAt:null,backendStartupMs:null,
    governedAcquiredAt:null,governedAdmissionMs:9000}));
  expect(node.textContent).toContain("First frame: unavailable");expect(node.textContent).toContain("9.0s (incomplete)");
  expect(node.textContent).toContain("No backend run recorded.");expect(node.textContent).toContain("Budget admission: not reached");
});
test("in-progress timing stays unavailable and historical timing stays unknown",()=>{
  const node=mount(fixture({endedAt:null,outcome:null,totalElapsedMs:null,firstFrameAt:null,timeToFirstFrameMs:null,
    backendStartupMs:null}));
  expect(node.textContent).toContain("Total turn: unavailable");expect(node.textContent).toContain("in progress");
  const historical=mount();
  expect(historical.textContent).toBe("Total turn: unknown · First frame: unknown");
});
