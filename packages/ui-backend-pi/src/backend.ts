/**
 * @schlessera/brain-backend-pi — the OSS-default AgentBackend, built on the upstream
 * pi coding-agent SDK (@earendil-works/pi-coding-agent).
 *
 * pi's built-in read/bash/edit/write tools are disabled (`noTools: "builtin"`)
 * and replaced with a curated, brain-repo-scoped tool set (see tools.ts).
 * The installed session, resource loader and tools run inside an isolated
 * per-turn worker. A tool_call gate requests server-owned permission decisions;
 * curated writes and bridge effects are authorized again on the server.
 * Conversations are server-owned SessionManager JSONL trees; native events
 * cross bounded protocol pipes before being translated to wire frames.
 *
 * Auth/model credentials come from pi's own mechanisms (env vars / `pi` auth
 * storage under the agent dir) — this backend does not manage keys.
 */
import { join } from "path";
import { piSessionDirectory } from "./session-storage.js";
import type {
  AgentBackend,
  BackendCapabilities,
  ChatSession,
  FollowUpRequest,
  SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk/server";
import {
  BackendRequestError,
  compileConfirmPatterns,
  createKeyedLock,
} from "@schlessera/brain-ui-sdk/server";
import { DEFAULT_CONFIRM_BASH_PATTERNS } from "@schlessera/brain-ui-sdk/server";
import { assertPiSdks } from "./version-requirements.js";

import type { CreatePiBackendOptions } from "./backend-options.js";
import { createBrainAccess } from "./brain-access.js";
import { listPiSessions, getPiHistory } from "./history.js";
import { listPiProfiles } from "./profiles.js";
import { createSessionPool } from "./session-pool.js";
import { createSessionResources } from "./session-resources.js";
import { createSessionRuntime } from "./session-runtime.js";
import {
  DEFAULT_PI_ALLOWED_TOOLS,
  toolLockFromKeyed,
  toolLockFromWriteLock,
} from "./tools.js";
import { createPiTurnRunner, toImages } from "./turn-runner.js";

export const PI_BACKEND_ID = "pi";

// Re-exports preserve direct source imports and the package index surface.
export type {
  BackendLogFn,
  CreatePiBackendOptions,
  PiProfile,
  PiSessionFactory,
  PiSessionLike,
  SessionToolkit,
} from "./backend-options.js";
export { mapPiEvent } from "./event-adapter.js";
export { createUsageAccumulator } from "./usage.js";

const CAPABILITIES: BackendCapabilities = {
  resume: true,
  permissions: true,
  thinking: true,
  attachments: true,
  askUser: true,
  costReporting: true,
  // Turns on different sessions run in parallel; mid-turn user messages are
  // injected into the running turn via followUp() (native pi queue-within-turn).
  concurrentSessions: true,
  followUp: true,
};

export function createPiBackend(options: CreatePiBackendOptions): AgentBackend {
  options = { ...options, ...(options.versionRequirements ? { versionRequirements: { ...options.versionRequirements } } : {}) };
  assertPiSdks(options.versionRequirements, "backend construction");
  const brainPath = options.brainPath;
  const sessionDir = options.sessionFactory
    ? options.sessionDir ?? join(brainPath, ".brain-kit-ui", "sessions")
    : piSessionDirectory(brainPath, options.sessionDir);
  const allowedTools: ReadonlySet<string> = new Set(
    options.allowedTools ?? DEFAULT_PI_ALLOWED_TOOLS
  );
  const confirmPatterns = compileConfirmPatterns(
    options.confirmBashPatterns ?? DEFAULT_CONFIRM_BASH_PATTERNS,
    (source, message) =>
      options.log?.("error", "invalid confirm pattern; it will never match", {
        pattern: source,
        error: message,
      })
  );
  const brain = createBrainAccess(brainPath);
  // Shared across all sessions: read paths are parallel-safe (per-call handles,
  // busy_timeout on the write path); mutations serialize per contention key
  // (git staging, brain-docs reindex, per-file writes) so independent work —
  // including parallel sibling tool calls in one assistant message — actually
  // runs in parallel. An injected legacy WriteLock opts back into whole-lock
  // serialization (a deployment sharing one mutex with another writer).
  const applicationLock = createKeyedLock();
  const lock = options.writeLock
    ? toolLockFromWriteLock(options.writeLock)
    : toolLockFromKeyed(applicationLock);
  const resources = createSessionResources({
    backend: options,
    brain,
    lock,
    allowedTools,
    confirmPatterns,
    loadExtensions: options.loadExtensions ?? true,
  });
  const runtime = createSessionRuntime({ backend: options, sessionDir, resources });
  const pool = createSessionPool(runtime, Boolean(options.sessionFactory));
  const startTurn = createPiTurnRunner(pool, options);

  return {
    id: PI_BACKEND_ID,
    capabilities: { ...CAPABILITIES, autonomous: !options.sessionFactory, restrictedAutonomous: !options.sessionFactory },
    listProfiles: () => listPiProfiles(options),
    // `listUnavailableProfiles` is deliberately omitted (#1044): pi lists every
    // configured profile and checks its credential when a session starts, so
    // it never leaves a configured profile out and has none to report.
    brainApplicationPolicy(req) {
      const allowed = new Set(req.autonomous?.allowedTools ?? [...allowedTools]);
      const names = { add: "brain_add", update: "brain_update", archive: "brain_archive", write: "write_file", edit: "edit_file", staged: "apply_staged_changes" };
      const autoAllowed = (Object.keys(names) as (keyof typeof names)[]).filter(op => allowed.has(names[op]));
      return { autoAllowed, enforceAllowedTools: req.enforceAllowedTools, available: (req.noGrantSurface || req.autonomous) ? autoAllowed : Object.keys(names) as (keyof typeof names)[], lock: { withLock: (key, fn, admission) => lock.withKey(key, fn, admission) } };
    },
    startTurn,
    async followUp(req: FollowUpRequest): Promise<void> {
      // Follow-up only lands in a RUNNING turn; the host queues it as the
      // session's next turn otherwise.
      const entry = pool.sessions.get(req.sessionId);
      if (!entry || !entry.running) {
        throw new BackendRequestError(
          `No running turn for session ${req.sessionId} to deliver a follow-up to.`
        );
      }
      const images = toImages(req);
      // Injected into the live turn: pi's "followUp" queues the message within
      // the turn (delivered after the current assistant step + tool calls),
      // whereas "steer" would interrupt. Frames keep flowing through the
      // running turn's subscription/emit — no new subscription here.
      await entry.session.prompt(req.prompt, {
        streamingBehavior: "followUp",
        ...(images.length > 0 ? { images } : {}),
      });
    },
    listSessions(): Promise<ChatSession[]> {
      return listPiSessions(brainPath, sessionDir);
    },
    getHistory(sessionId: string): Promise<SessionHistoryMessage[]> {
      return getPiHistory(brainPath, sessionId, sessionDir);
    },
  };
}
