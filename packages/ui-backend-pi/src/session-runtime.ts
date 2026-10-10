import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import type { CreatePiBackendOptions, PiSessionLike, SessionEnv } from "./backend-options.js";
import type { TurnContext } from "./turn-context.js";
import type { createSessionResources } from "./session-resources.js";
import { openPiWorkerSession } from "./worker-session.js";
import { resolveModelSpec } from "./profiles.js";

export interface SessionRuntime {
  newSession(profileId: string | undefined, env: SessionEnv): Promise<{ session: PiSessionLike; turnContext: TurnContext }>;
  openSession(sessionId: string, env: SessionEnv): Promise<{ session: PiSessionLike; turnContext: TurnContext }>;
}

export function createSessionRuntime(options: {
  backend: CreatePiBackendOptions;
  sessionDir: string;
  resources: ReturnType<typeof createSessionResources>;
}): SessionRuntime {
  async function acquire(env: SessionEnv, profileId?: string, sessionId?: string) {
    if (!sessionId) resolveModelSpec(options.backend, profileId);
    // Internal contract doubles carry no installed SDK/extension writer. The
    // production path always enters the shared worker boundary.
    if (options.backend.sessionFactory) {
      if (env.autonomous) throw new BackendRequestError("Injected session factories do not support nonpersistent turns.");
      const toolkit = options.resources.buildToolkit(env.caps);
      const session = sessionId
        ? await options.backend.sessionFactory.openSession(sessionId, toolkit)
        : await options.backend.sessionFactory.newSession(profileId, toolkit);
      return { session, turnContext: toolkit.turnContext };
    }
    return openPiWorkerSession(options.backend, options.sessionDir, env, profileId, sessionId);
  }
  return {
    newSession: (profileId, env) => acquire(env, profileId),
    openSession: (sessionId, env) => acquire(env, undefined, sessionId),
  };
}
