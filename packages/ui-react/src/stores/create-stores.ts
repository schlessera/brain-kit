import { createUIStore } from "./ui-state.js";
import { createConnectionStore } from "./connection-state.js";
import { createProviderStore } from "./provider-state.js";
import { createChatStore } from "./chat-state.js";
import { createFileStore } from "./file-state.js";
import { createGraphStore } from "./graph-state.js";
import { createActivityStore } from "./activity-state.js";
import { createPrincipalStore } from "./principal-state.js";
import { createMaskStore } from "./mask-state.js";
import { createShareStore } from "./share-state.js";
import { createVoiceStore } from "../voice/voice-state.js";
import type { StoreEnvironment } from "./store-environment.js";

export function createBrainStores(env: StoreEnvironment) {
  const provider = createProviderStore(env);
  return {
    provider,
    chat: createChatStore(env, provider),
    ui: createUIStore(env),
    connection: createConnectionStore(),
    file: createFileStore(env),
    graph: createGraphStore(env),
    activity: createActivityStore(env),
    principal: createPrincipalStore(env),
    mask: createMaskStore(),
    share: createShareStore(),
    voice: createVoiceStore(),
  };
}

export type BrainStores = ReturnType<typeof createBrainStores>;
