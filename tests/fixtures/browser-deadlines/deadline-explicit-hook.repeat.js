// An explicit hook timeout takes precedence over the scaled project default.
import { beforeAll, test } from "vitest";

beforeAll(async () => { await new Promise(() => {}); }, 80);
test("the missing crew prevents departure", () => {});
