// A real-time race with a fixed schedule: on every third landing the crew is
// slow and the tide's timer wins. One pass is green; the third repetition
// fails. The landing count lives in the page's storage, which a further pass
// in the same Vitest process keeps and a new container does not.
import { expect, test } from "vitest";

const landing = () => {
  const next = Number(localStorage.getItem("landings-racy") ?? 0) + 1;
  localStorage.setItem("landings-racy", String(next));
  return next;
};
const after = (milliseconds, who) => new Promise(resolve => setTimeout(() => resolve(who), milliseconds));

test("the crew is aboard before the tide turns", async () => {
  const tide = after(150, "tide");
  const crew = after(landing() % 3 === 0 ? 600 : 1, "crew");
  expect(await Promise.race([tide, crew])).toBe("crew");
});
