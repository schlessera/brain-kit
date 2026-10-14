/** Policy unit fixtures replace only native acquisition; native runtime proof is separate. */
import { afterEach, beforeEach, spyOn } from "bun:test";
import * as startup from "../../../ui-sdk/src/server/worker-startup-view.js";
import * as output from "../../../ui-sdk/src/server/worker-native-output.js";
import { createFixtureWorkerStartupView, prepareFixtureNativeWorkerOutput } from "../../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
let references = 0;
let acquisition: ReturnType<typeof spyOn<typeof startup, "prepareNativeWorkerStartupView">> | undefined;

let outputAcquisition: ReturnType<typeof spyOn<typeof output, "prepareNativeWorkerOutput">> | undefined;

export function installFixtureNativeStartupViews(): void {
  let restore: (() => void) | undefined;
  beforeEach(() => { restore = replaceNativeStartupAcquisitionForFixture(); });
  afterEach(() => { restore?.(); restore = undefined; });
}

/** Standalone fixture subprocesses restore on shutdown; never imported by product code. */
export function replaceNativeStartupAcquisitionForFixture(): () => void {
  if (references++ === 0) {
    outputAcquisition = spyOn(output, "prepareNativeWorkerOutput").mockImplementation(prepareFixtureNativeWorkerOutput);
    acquisition = spyOn(startup, "prepareNativeWorkerStartupView").mockImplementation(async (brain, _manager, signal) => {
      signal?.throwIfAborted(); return createFixtureWorkerStartupView(brain);
    });
  }
  let closed = false;
  return () => { if (closed) return; closed = true; if (--references === 0) { acquisition?.mockRestore(); acquisition = undefined; outputAcquisition?.mockRestore(); outputAcquisition = undefined; } };
}
