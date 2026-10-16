import { RunRow } from "../../src/components/activity/activity-run-list.js";
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";
import { TurnTiming } from "../../src/components/activity/turn-timing.js";

let renderer: Root | undefined;
let host: HTMLDivElement | undefined;
let style: HTMLStyleElement | undefined;
afterEach(()=>{if(renderer)flushSync(()=>renderer!.unmount());host?.remove();style?.remove();renderer=undefined;});
const fixture = (over: Partial<ActivityTurnLifecycle>): ActivityTurnLifecycle => ({
  hostEvents: [], skippedPhases: [],lifecycleId:"lifecycle:turn-ithaca",turnId:"turn-ithaca",sessionId:"ithaca",backendRunId:"turn-ithaca",acceptedAt:1000,dequeuedAt:null,
  governedStartedAt:1000,governedAcquiredAt:2000,budgetStartedAt:2000,budgetAdmittedAt:3000,
  journalStartedAt:3000,journalBeganAt:4000,backendInvokedAt:4000,firstFrameAt:6000,failureObservedAt:null,endedAt:10000,
  outcome:"success",reason:null,totalElapsedMs:9000,timeToFirstFrameMs:5000,queueWaitMs:null,
  governedAdmissionMs:1000,budgetAdmissionMs:1000,journalBeginMs:1000,backendStartupMs:2000,...over,
});
async function mount(lifecycle?: ActivityTurnLifecycle) {
  await page.viewport(320,640);
  style=document.createElement("style");style.textContent=await commands.formConsumerStyles();document.head.append(style);
  host=document.createElement("div");host.style.width="320px";document.body.append(host);renderer=createRoot(host);
  flushSync(()=>renderer!.render(<TurnTiming lifecycle={lifecycle}/>));
  return host;
}
test("real timing presentation distinguishes total turn, first frame and startup at 320px",async()=>{
  const node=await mount(fixture({}));
  expect(node.textContent).toContain("Total turn: 9.0s");expect(node.textContent).toContain("First frame: 5.0s");
  expect(node.textContent).toContain("Backend startup: 2.0s");
  expect(node.scrollWidth).toBeLessThanOrEqual(320);
});
test("refused admission shows actual incomplete time without inventing backend execution",async()=>{
  const node=await mount(fixture({outcome:"denied",reason:"Admission refused",backendRunId:null,firstFrameAt:null,
    timeToFirstFrameMs:null,budgetStartedAt:null,budgetAdmittedAt:null,budgetAdmissionMs:null,
    journalStartedAt:null,journalBeganAt:null,journalBeginMs:null,backendInvokedAt:null,backendStartupMs:null,
    governedAcquiredAt:null,governedAdmissionMs:9000}));
  expect(node.textContent).toContain("First frame: unavailable");expect(node.textContent).toContain("9.0s (incomplete)");
  expect(node.textContent).toContain("No backend run recorded.");expect(node.textContent).toContain("Budget admission: not reached");
});
test("in-progress timing stays unavailable and historical timing stays unknown",async()=>{
  const node=await mount(fixture({endedAt:null,outcome:null,totalElapsedMs:null,firstFrameAt:null,timeToFirstFrameMs:null,
    backendStartupMs:null}));
  expect(node.textContent).toContain("Total turn: unavailable");expect(node.textContent).toContain("in progress");
  flushSync(()=>renderer!.render(<TurnTiming/>));
  expect(node.textContent).toBe("Total turn: unknown · First frame: unknown");
});


test("the actual history row keeps backend duration and first-frame timing visible at 320px",async()=>{
  const lifecycle=fixture({});const node=await mount(lifecycle);
  flushSync(()=>renderer!.render(<RunRow run={{runId:"turn-ithaca",origin:"session",name:"Plan Ithaca",sessionId:"ithaca",jobName:null,
    startedAt:6000,endedAt:10000,outcome:"success",running:false,durationMs:4000,costUsd:null,failureReason:null,detailPruned:false,lifecycle}}
    onOpen={()=>{}}/>));
  expect(node.textContent).toContain("Backend: 4.0s");expect(node.textContent).toContain("First frame: 5.0s");
  expect(node.scrollWidth).toBeLessThanOrEqual(320);
  const timing=node.querySelector("p")!.getBoundingClientRect();expect(timing.width).toBeLessThanOrEqual(320);expect(timing.height).toBeGreaterThan(0);
});
