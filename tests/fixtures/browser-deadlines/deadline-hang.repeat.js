// Selected only by the harness's negative receipt: a real unresolved promise.
import { test } from "vitest";

test("the missing crew never arrives", async () => {
  await new Promise(() => {});
});
