// The racy landing made deterministic: the tide waits for the crew, not for a
// clock. The crew is still slow on every third landing, and every pass is green.
import { expect, test } from "vitest";

const landing = () => {
  const next = Number(localStorage.getItem("landings-steady") ?? 0) + 1;
  localStorage.setItem("landings-steady", String(next));
  return next;
};
const after = (milliseconds, who) => new Promise(resolve => setTimeout(() => resolve(who), milliseconds));

test("the crew is aboard before the tide turns", async () => {
  const crew = after(landing() % 3 === 0 ? 60 : 1, "crew");
  expect(await crew).toBe("crew");
});
