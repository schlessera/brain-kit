// A fixture of render-smoke-cleanup-runtime.test.ts, run only in that test's
// child process: a RunDetail whose run detail is still in flight when the
// smoke harness's file teardown runs.
//
// The DOM module import MUST stay first (../render/dom.ts explains why).
import { registerRunDetailTeardownDom, unregisterRunDetailTeardownDom } from "./run-detail-teardown-dom.js";
registerRunDetailTeardownDom();

import { installSmokeHarness } from "../render/smoke-harness.js";
import { afterAll, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { RunDetail } from "../../src/components/activity/activity-run-detail.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";

installSmokeHarness(unregisterRunDetailTeardownDom);

describe("RunDetail still loading when the file's teardown runs", () => {
  let requests = 0;
  const root = createBrainUiRoot({ storage: null, request: async () => {
    requests += 1;
    // Answer on a later turn, after the file's teardown has started. Bun's own
    // timer: happy-dom cancels its timers when it closes.
    await Bun.sleep(0);
    // A missing run: the view answers it with its own state update.
    return Response.json({ error: "not found" }, { status: 404 });
  } });
  root.stores.activity.setState({ supported: true });

  // The harness unmounts every render a test makes after that test, so a
  // render left for the file's teardown is one made after the last test: a
  // describe's afterAll runs after it and before the file's own afterAll.
  afterAll(() => {
    render(<BrainUiProvider root={root}><RunDetail runId="teardown-run" onBack={() => {}} /></BrainUiProvider>);
    expect(requests).toBe(1);
  });

  test("teardown fixture mounts RunDetail only after its last test", () => {
    expect(requests).toBe(0);
  });
});
