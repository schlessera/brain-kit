import { expect, test } from "bun:test";
import { checkLayerDirection, isLowerLayer } from "../scripts/check-layer-direction.js";

const store = "packages/ui-react/src/stores/chat-state.ts";
test("layer gate covers stores/, lib/ and connection.ts only", () => {
  for (const file of [store, "packages/ui-react/src/lib/stats/compose-stats.ts", "packages/ui-react/src/connection.ts", "packages/ui-react/src/ws-client/inbound.ts"]) expect(isLowerLayer(file)).toBe(true);
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
    'packages/ui-react/src/connection.ts:1: ./components/connectivity/connection-state.js — stores/, lib/, connection.ts and ws-client/ must not import components/; move the shared code into lib/',
  ]);
});

const coreLib = "packages/core/src/lib/archiver.ts";
test("layer gate covers core's lib/, providers/, queries/ and config/", () => {
  for (const file of [coreLib, "packages/core/src/providers/embeddings/gemini.ts", "packages/core/src/queries/links.ts", "packages/core/src/config/env.ts"]) expect(isLowerLayer(file)).toBe(true);
  for (const file of ["packages/core/src/cli/main.ts", "packages/core/src/mcp-server.ts", "packages/core/src/module.ts", "packages/core/src/internal.ts"]) expect(isLowerLayer(file)).toBe(false);
});
test("layer gate reports a core lower-layer import of cli/ with its file and line", () => {
  expect(checkLayerDirection('import type { X } from "./x.js";\nimport { UsageError } from "../cli/io.js";', coreLib)).toEqual([
    "packages/core/src/lib/archiver.ts:2: ../cli/io.js — lib/, providers/, queries/ and config/ must not import cli/; move the shared code out of cli/",
  ]);
  expect(checkLayerDirection('const { runBrainCli } = await import("../../cli/main.js");', "packages/core/src/lib/skills/sync.ts")).toEqual([
    "packages/core/src/lib/skills/sync.ts:1: ../../cli/main.js — lib/, providers/, queries/ and config/ must not import cli/; move the shared code out of cli/",
  ]);
});
test("layer gate lets core's cli/ import lib/", () => {
  expect(checkLayerDirection('import { openDatabase } from "../lib/db.js";', "packages/core/src/cli/main.ts")).toEqual([]);
  expect(checkLayerDirection('import { openDatabase } from "../lib/db.js";', coreLib)).toEqual([]);
});
