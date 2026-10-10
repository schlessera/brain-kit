import { expect, test } from "bun:test";
import { checkLayerDirection, isLowerLayer } from "../scripts/check-layer-direction.js";

const store = "packages/ui-react/src/stores/chat-state.ts";
test("layer gate covers stores/, lib/ and connection.ts only", () => {
  for (const file of [store, "packages/ui-react/src/lib/stats/compose-stats.ts", "packages/ui-react/src/connection.ts"]) expect(isLowerLayer(file)).toBe(true);
  for (const file of ["packages/ui-react/src/components/chat/composer.tsx", "packages/ui-react/src/hooks/use-now.ts", "packages/ui-react/src/connection-x.ts"]) expect(isLowerLayer(file)).toBe(false);
});
test("layer gate permits lib, stores, packages and comments", () => {
  expect(checkLayerDirection([
    'import { cn } from "../lib/utils.js";',
    'import type { VpnStatus } from "./connection-store.js";',
    'import { Button } from "@schlessera/brain-ui-kit";',
    '// import { X } from "../components/chat/composer.js";',
    'const path = "../components/chat/composer.js";',
  ].join("\n"), store)).toEqual([]);
});
test("layer gate rejects every import form that reaches components/", () => {
  for (const line of [
    'import { StatsSection } from "../components/chat/stats/stats-answer.js";',
    'import type { StatsSection } from "../components/chat/stats/stats-answer.js";',
    'export { ChatPage } from "../components/chat/chat-page.js";',
    'export * from "../components/chat/chat-page.js";',
    'const page = await import("../components/chat/chat-page.js");',
    'type Page = typeof import("../components/chat/chat-page.js");',
    'import "../components/chat/chat-page.js";',
  ]) expect(checkLayerDirection(line, store), line).toHaveLength(1);
  expect(checkLayerDirection('import { REFUSAL_ATTEMPTS } from "./components/connectivity/connection-state.js";', "packages/ui-react/src/connection.ts")).toEqual([
    'packages/ui-react/src/connection.ts:1: ./components/connectivity/connection-state.js — stores/, lib/ and connection.ts must not import components/; move the shared code into lib/',
  ]);
});
