import { expect, test } from "bun:test";
import { checkRootStores } from "../scripts/check-root-stores.js";

const imported = 'import { useChatStore } from "./stores/chat-store.js";\n';
test("root-store gate permits selector calls and explicit roots", () => {
  expect(checkRootStores(imported + 'const value = useChatStore(s => s.draft); root.stores.chat.getState();')).toEqual([]);
  expect(checkRootStores('// useChatStore.getState()\nconst text = "useChatStore.getState()";')).toEqual([]);
});
test("root-store gate rejects dot, bracket, destructured and aliased statics", () => {
  for (const access of [
    'useChatStore.getState()', 'useChatStore["setState"]({})',
    'const { getState } = useChatStore;', 'const alias = useChatStore; alias.getState()',
  ]) expect(checkRootStores(imported + access).length).toBeGreaterThan(0);
  expect(checkRootStores('import { useChatStore as useChat } from "./chat-store.js"; useChat.getState()')).toHaveLength(1);
});
test("root-store gate follows namespace imports", () => {
  for (const access of ['stores.useChatStore.getState()', 'stores["useChatStore"].getState()']) {
    expect(checkRootStores('import * as stores from "@schlessera/brain-ui-react";' + access)).toHaveLength(1);
  }
  expect(checkRootStores('import * as stores from "./chat-store.js"; stores.useChatStore(s => s.draft)')).toEqual([]);
});
