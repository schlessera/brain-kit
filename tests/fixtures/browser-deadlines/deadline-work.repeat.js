// A fixed amount of CPU work, about half the fixture project's unloaded 1 s
// timeout. Under deliberate CPU contention it needs the repetition factor.
import { expect, test } from "vitest";

test("the crew counts the oars under load", () => {
  const start = performance.now();
  let count = 1;
  for (let index = 0; index < 500_000_000; index++) count = Math.imul(count ^ index, 1_664_525);
  console.log(`Oar count took ${(performance.now() - start).toFixed(0)} ms`);
  expect(count).toBe(793779201);
});
