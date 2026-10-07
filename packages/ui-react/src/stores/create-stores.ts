import { createUIStore } from "./ui-state.js";
import { createConnectionStore } from "./connection-state.js";
import { createProviderStore } from "./provider-state.js";
import { createChatStore } from "./chat-state.js";
import { createFileStore } from "./file-state.js";
import { createGraphStore } from "./graph-state.js";
import { createActivityStore } from "./activity-state.js";
import { createPrincipalStore } from "./principal-state.js";
import { createInboxStore } from "./inbox-state.js";
import { createMaskStore } from "./mask-state.js";
import { createShareStore } from "./share-state.js";
import { createHandoffStore } from "./handoff-state.js";
import { createFollowUpStore } from "./follow-up-state.js";
import { createVoiceStore } from "../voice/voice-state.js";
import { createTrackerStore } from "./tracker-state.js";
import { createSessionListStore } from "./session-list-state.js";
import { createDraftStore } from "./draft-state.js";
import type { StoreEnvironment } from "./store-environment.js";

export function createBrainStores(env: StoreEnvironment) {
  const provider = createProviderStore(env);
  const handoff = createHandoffStore(env);
  // Every composer's draft (D52 §5): New chat gives the new-chat view a fresh one.
  const drafts = createDraftStore();
  return {
    provider,
    drafts,
    chat: createChatStore(env, provider, drafts),
    ui: createUIStore(env),
    connection: createConnectionStore(),
    file: createFileStore(env),
    graph: createGraphStore(env),
    activity: createActivityStore(env),
    inbox: createInboxStore(),
    principal: createPrincipalStore(env),
    mask: createMaskStore(),
    share: createShareStore(),
    handoff,
    followUp: createFollowUpStore(),
    voice: createVoiceStore(),
    trackers: createTrackerStore(env),
    // The list is where handoff links live (#61): every answer indexes them.
    sessions: createSessionListStore(env, (sessions) => handoff.getState().setLinks(sessions)),
  };
}

export type BrainStores = ReturnType<typeof createBrainStores>;
