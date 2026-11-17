// A default hook cap of 700 ms becomes 2,100 ms inside the loaded command.
import { beforeAll, expect, test } from "vitest";

let aboard = false;
beforeAll(async () => {
  await new Promise(done => setTimeout(done, 1000));
  aboard = true;
});
test("the crew is aboard after the hook", () => { expect(aboard).toBe(true); });
