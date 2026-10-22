import { expect, test } from "vitest";
import { DESKTOP, PALETTE_ROWS, allowed, startsAt, targets } from "./navigation-reach-fixture.js";

test("the matrix: every target has a count for every start at every width", () => {
  for (const width of DESKTOP) for (const start of startsAt(width)) for (const name of Object.keys(targets)) {
    expect(Number.isInteger(allowed(name, start, width)), `${name} from ${start} at ${width}`).toBe(true);
  }
  expect(new Set(PALETTE_ROWS).size, "one target per palette row").toBe(PALETTE_ROWS.length);
});
