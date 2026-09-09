import {
  createAgentSession,
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
}): SessionRuntime {
  const { backend, sessionDir, resources } = options;
  const brainPath = backend.brainPath;

  return {
    async newSession(profileId, env) {
      // A bad profile throws BackendRequestError before anything is emitted.
      const spec = resolveModelSpec(backend, profileId);
      const toolkit = resources.buildToolkit(env.caps);
      if (backend.sessionFactory) {
        const session = await backend.sessionFactory.newSession(profileId, toolkit);
        return { session, turnContext: toolkit.turnContext };
      }
      const sm = SessionManager.create(brainPath, sessionDir);
      const loaded = await resources.build(toolkit, env);
      // A declared model missing from the catalog fails instead of falling back.
      const model = toModel(spec);
      const { session } = await createAgentSession({
        cwd: brainPath,
        noTools: "builtin",
        customTools: toolkit.tools,
        sessionManager: sm,
        resourceLoader: loaded.loader,
        settingsManager: loaded.settingsManager,
        ...(model ? { model } : {}),
        ...(spec?.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
      });
      return { session, turnContext: toolkit.turnContext };
    },

    async openSession(sessionId, env) {
      const toolkit = resources.buildToolkit(env.caps);
      if (backend.sessionFactory) {
        const session = await backend.sessionFactory.openSession(sessionId, toolkit);
        return { session, turnContext: toolkit.turnContext };
      }
      const infos = await SessionManager.list(brainPath, sessionDir);
      const info = infos.find((i) => i.id === sessionId);
      if (!info) {
        throw new BackendRequestError(`Cannot resume unknown session: ${sessionId}`);
      }
      const sm = SessionManager.open(info.path, sessionDir);
      const loaded = await resources.build(toolkit, env);
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: brainPath,
        noTools: "builtin",
        customTools: toolkit.tools,
        sessionManager: sm,
        resourceLoader: loaded.loader,
        settingsManager: loaded.settingsManager,
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
