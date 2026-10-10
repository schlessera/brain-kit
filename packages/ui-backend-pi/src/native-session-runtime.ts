import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";

import type {
  CreatePiBackendOptions,
  PiSessionLike,
  SessionEnv,
} from "./backend-options.js";
import { resolveModelSpec, toModel } from "./profiles.js";
import type { TurnContext } from "./turn-context.js";
import type { createSessionResources } from "./session-resources.js";

export interface SessionRuntime {
  newSession(
    profileId: string | undefined,
    env: SessionEnv
  ): Promise<{ session: PiSessionLike; turnContext: TurnContext }>;
  openSession(
    sessionId: string,
    env: SessionEnv
  ): Promise<{ session: PiSessionLike; turnContext: TurnContext }>;
}

export function createSessionRuntime(options: {
  backend: CreatePiBackendOptions;
  sessionDir: string;
  resources: ReturnType<typeof createSessionResources>;
  sessionId: string;
  entries?: import("@earendil-works/pi-coding-agent").FileEntry[];
  observeManager: (manager: SessionManager) => void;
  modelRuntimeOptions: import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions;
}): SessionRuntime {
  const { backend, resources } = options;
  const brainPath = backend.brainPath;

  return {
    async newSession(profileId, env) {
      // A bad profile throws BackendRequestError before anything is emitted.
      const spec = resolveModelSpec(backend, profileId);
      const toolkit = resources.buildToolkit(env.caps);
      // A declared model missing from the catalog fails instead of falling back.
      const declaredModel = toModel(spec);
      const sm = SessionManager.inMemory(brainPath, { id: options.sessionId }, options.entries);
      options.observeManager(sm);
      const loaded = await resources.build(toolkit, env);
      // Native discovery owns models/auth/cache paths and per-request auth.
      // Select from the SAME configured runtime that performs inference.
      const modelRuntime = await ModelRuntime.create(options.modelRuntimeOptions);
      const model = declaredModel ? modelRuntime.getModel(declaredModel.provider, declaredModel.id) : undefined;
      if (declaredModel && (!model || model.provider !== declaredModel.provider || model.id !== declaredModel.id)) {
        throw new BackendRequestError(
          `Cannot resolve configured model "${declaredModel.provider}/${declaredModel.id}". ` +
            "Restore the declared built-in model in pi's native configuration."
        );
      }
      const { session } = await createAgentSession({
        cwd: brainPath,
        noTools: "builtin",
        customTools: toolkit.tools,
        sessionManager: sm,
        resourceLoader: loaded.loader,
        settingsManager: loaded.settingsManager,
        modelRuntime,
        ...(model ? { model } : {}),
        ...(spec?.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
      });
      return { session, turnContext: toolkit.turnContext };
    },

    async openSession(sessionId, env) {
      const toolkit = resources.buildToolkit(env.caps);
      if (!options.entries || sessionId !== options.sessionId) {
        throw new BackendRequestError(`Cannot resume unknown session: ${sessionId}`);
      }
      const sm = SessionManager.inMemory(brainPath, { id: options.sessionId }, options.entries);
      options.observeManager(sm);
      const loaded = await resources.build(toolkit, env);
      const modelRuntime = await ModelRuntime.create(options.modelRuntimeOptions);
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: brainPath,
        noTools: "builtin",
        customTools: toolkit.tools,
        sessionManager: sm,
        resourceLoader: loaded.loader,
        settingsManager: loaded.settingsManager,
        modelRuntime,
      });
      // Resumed sessions stay pinned to their saved model — no model override.
      // pi otherwise silently substitutes another configured model when the
      // saved one is unavailable (catalog change, missing/expired credential).
      // Refuse: continuing would run on a different model, and possibly a
      // different provider and billing, under the session's pinned identity.
      if (modelFallbackMessage) {
        try {
          session.dispose();
        } catch {
          // Best-effort: the rejection below is the primary signal.
        }
        throw new BackendRequestError(
          `Cannot resume on the session's saved model: ${modelFallbackMessage} ` +
            "Restore the credential (e.g. `pi login`) or start a new conversation."
        );
      }
      return { session, turnContext: toolkit.turnContext };
    },
  };
}
