// Throwaway measurement probe for #4116. Never committed.
import { expect, test } from "vitest";
let run = 0;
test("fails on its second repetition only", { repeats: 3 }, () => { run++; console.info("REPFAIL run", run); expect(run).not.toBe(2); });
test("next test still runs", () => { console.info("REPFAIL next after", run); });
