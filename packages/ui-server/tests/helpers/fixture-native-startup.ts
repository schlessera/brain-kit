/** Policy unit fixtures replace only native acquisition; native runtime proof is separate. */
import { afterEach, beforeEach, spyOn } from "bun:test";
import * as startup from "../../../ui-sdk/src/server/worker-startup-view.js";
import * as output from "../../../ui-sdk/src/server/worker-native-output.js";
import { createFixtureWorkerStartupView, prepareFixtureNativeWorkerOutput } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
let references = 0;
let acquisition: ReturnType<typeof spyOn<typeof startup, "prepareNativeWorkerStartupView">> | undefined;

let outputAcquisition: ReturnType<typeof spyOn<typeof output, "prepareNativeWorkerOutput">> | undefined;
let managed: ReturnType<typeof spyOn<typeof startup, "assertManagedTurnStartupView">> | undefined;
/** Views this stand-in acquired: copies, never a native checkpoint. */
const acquired = new WeakSet<object>();
/** Whether turn admission's acquisition stand-in made this view (#3314). */
export function isFixtureStartupView(view: unknown): view is startup.WorkerStartupView {
  return typeof view === "object" && view !== null && acquired.has(view);
}

export function installFixtureNativeStartupViews(): void {
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = replaceNativeStartupAcquisitionForFixture(); });
  afterEach(() => { restore?.(); restore = undefined; });
}

/** Standalone fixture subprocesses restore on shutdown; never imported by product code. */
export function replaceNativeStartupAcquisitionForFixture(): () => void {
  references++;
  // Another suite may restore every Bun spy while an app fixture is alive.
  // Each explicit acquisition re-establishes its test-only boundary.
  {
    outputAcquisition = spyOn(output, "prepareNativeWorkerOutput").mockImplementation(prepareFixtureNativeWorkerOutput);
    acquisition = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async (brain, _manager, signal) => {
      signal?.throwIfAborted();
      const view = createFixtureWorkerStartupView(brain); acquired.add(view); return view;
    });
    // A copied fixture view stands in for a manager-acquired one at turn
    // admission's refusal only (#3314); everything else still sees it as
    // unmanaged. A test of the refusal reinstates the real one.
    managed = spyOn(startup, "assertManagedTurnStartupView").mockImplementation(() => {});
  }
  let closed = false;
  return () => { if (closed) return; closed = true; if (--references === 0) { acquisition?.mockRestore(); acquisition = undefined; outputAcquisition?.mockRestore(); outputAcquisition = undefined; managed?.mockRestore(); managed = undefined; } };
}
