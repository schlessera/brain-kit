/**
 * Cross-backend handoff (#61, docs/decisions/session-handoff.md).
 *
 * A conversation never changes backend. Continuing it elsewhere creates a
 * NEW session on the chosen backend, seeded with a summary the user reviewed
 * and the brain files they kept as references. Three pieces live here:
 *
 * - **Preparation** (`handoff_prepare`): one model run on the SOURCE
 *   session's own backend that drafts the summary. It is nonpersistent and
 *   toolless, attributed to the source session in Activity as a
 *   `handoff preparation` run, and its cost joins the source's total without
 *   counting a turn.
 * - **Creation** (`chat_message.handoff`): the host checks the source and
 *   every reference under the current principal, refuses a destination on
 *   the source's own backend, then starts the destination through ordinary
 *   routing with the reviewed text as its first user message.
 * - **Idempotency** (`handoff_status`): the client-minted `handoffId` is the
 *   key. A repeated key returns the destination it already created, or
 *   `pending` while that creation is in flight, and never a second session.
 *
 * Nothing transfers: no native history, no approvals or remembered grants,
 * no running work. The destination's turns follow its own profile's policy.
 */
import { stat } from "node:fs/promises";
import {
  composeHandoffText,
  HANDOFF_MAX_CHARS,
  HANDOFF_MAX_REFERENCES,
  type ClientChatMessage,
  type ClientHandoffPrepare,
  type SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { isBrowseablePath, safeResolve } from "../files/walker.js";
import { createTurnRecorder, type TurnRecorder } from "../activity/recorder.js";
import type { WSContext } from "./clients.js";
import type { ConnectionState } from "./dispatch.js";
import type { WsHost } from "./host.js";
import { handleChatMessage, resolveRunBilling } from "./run-session.js";

/** The Activity name of the summary run on the source session. */
export const HANDOFF_PREPARATION_RUN_NAME = "handoff preparation";
/** Upper bound on one preparation run, independent of the turn timeout. */
export const HANDOFF_PREPARATION_TIMEOUT_MS = 120_000;
/** Most transcript characters handed to the summarizer, newest kept. */
export const HANDOFF_TRANSCRIPT_BUDGET_CHARS = 40_000;

const SUMMARY_SYSTEM_PROMPT = [
  "You are writing a handoff: a summary of a conversation so that a different assistant can continue it in a new chat.",
  "The new assistant will see ONLY your summary, so state the goal, the decisions and facts established, open questions and the next step.",
  "Write plain text in the conversation's language. No preamble, no headings about yourself, no tool use.",
  `Stay under ${HANDOFF_MAX_CHARS} characters. Reply with the summary only.`,
].join(" ");

export type ReferenceState = "readable" | "missing" | "unreadable";

/**
 * Whether the destination may be offered each referenced brain file. The
 * same check the file browser applies: contained in the brain, an existing
 * file, and not tooling (dot paths, databases, lockfiles).
 */
export async function checkHandoffReferences(
  brainPath: string | undefined,
  references: readonly string[]
): Promise<Array<{ path: string; state: ReferenceState }>> {
  const out: Array<{ path: string; state: ReferenceState }> = [];
  for (const path of references) {
    if (!brainPath || !isBrowseablePath(path)) {
      out.push({ path, state: "unreadable" });
      continue;
    }
    try {
      const abs = await safeResolve(path, brainPath);
      const info = await stat(abs);
      out.push({ path, state: info.isFile() ? "readable" : "unreadable" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      out.push({ path, state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" });
    }
  }
  return out;
}

function refuse(host: WsHost, ws: WSContext, msg: Pick<ClientChatMessage, "requestId">, message: string): void {
  host.sendMessage(ws, {
    type: "error",
    code: "HANDOFF_REJECTED",
    message,
    ...(msg.requestId ? { requestId: msg.requestId } : {}),
  });
}

/**
 * Create a handoff destination, or return the one this key already made.
 * The in-flight entry is claimed synchronously, before the first await, so
 * two copies of one request (a retry racing a slow first attempt) cannot
 * both pass the duplicate check.
 */
export async function startHandoff(
  host: WsHost,
  ws: WSContext,
  msg: ClientChatMessage & { handoff: NonNullable<ClientChatMessage["handoff"]> },
  connection: ConnectionState
): Promise<void> {
  const { handoff } = msg;
  const { coordinator, catalog } = host;
  if (msg.sessionId) return refuse(host, ws, msg, "A handoff starts a new chat; it can't continue an existing one.");
  if (msg.attachments?.length || msg.files?.length || msg.localExchanges?.length) {
    return refuse(host, ws, msg, "A handoff carries only its reviewed text and references.");
  }
  if (!msg.text.trim()) return refuse(host, ws, msg, "The handoff is empty. Write what the new chat should know.");
  if (msg.text.length > HANDOFF_MAX_CHARS) return refuse(host, ws, msg, `Shorten the handoff to ${HANDOFF_MAX_CHARS} characters.`);
  if (!catalog.recordHandoff || !catalog.findHandoff) return refuse(host, ws, msg, "This server can't record handoffs.");

  let existing: string | null;
  try { existing = catalog.findHandoff(handoff.handoffId); }
  catch { return refuse(host, ws, msg, "The server couldn't check this handoff. Check again before retrying."); }
  if (existing) {
    host.sendMessage(ws, { type: "handoff_receipt", handoffId: handoff.handoffId, state: "created", sessionId: existing });
    return;
  }
  if (coordinator.handoffs.has(handoff.handoffId)) {
    const pending = coordinator.handoffs.get(handoff.handoffId)!;
    host.sendMessage(ws, {
      type: "handoff_receipt",
      handoffId: handoff.handoffId,
      state: pending.sessionId ? "created" : "pending",
      ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
    });
    return;
  }
  const entry: { sessionId?: string } = {};
  coordinator.handoffs.set(handoff.handoffId, entry);
  let handedOver = false;
  const release = () => {
    if (coordinator.handoffs.get(handoff.handoffId) === entry) coordinator.handoffs.delete(handoff.handoffId);
  };
  try {
    const sourceBackendId = catalog.getStoredBackendId(handoff.sourceSessionId);
    if (!sourceBackendId) return refuse(host, ws, msg, "The source chat isn't known to this server.");
    const providers = await host.registry.listAllProviders();
    const destination = msg.providerId ? providers.find((profile) => profile.id === msg.providerId) : undefined;
    const backend = destination ? await host.registry.getBackendForProfile(destination.id) : undefined;
    if (!destination || !backend) return refuse(host, ws, msg, "Choose an available profile on another backend.");
    if (backend.id === sourceBackendId) {
      return refuse(host, ws, msg, "That profile runs on this chat's own backend. Start a new chat there instead.");
    }
    const references = [...new Set(handoff.references)].slice(0, HANDOFF_MAX_REFERENCES);
    const checked = await checkHandoffReferences(host.brainPath, references);
    const blocked = checked.filter((reference) => reference.state !== "readable");
    if (blocked.length) {
      return refuse(host, ws, msg, `Not readable by ${backend.id}: ${blocked.map((reference) => reference.path).join(", ")}. Remove it and try again.`);
    }
    // Where the source stood, so its forward marker keeps its place as the
    // source continues. Unreadable history is not a reason to refuse.
    let sourceMessages: number | null = null;
    try {
      const sourceBackend = await host.registry.getBackendForSession(sourceBackendId);
      sourceMessages = host.prepareHistory(handoff.sourceSessionId, await sourceBackend.getHistory(handoff.sourceSessionId)).length;
    } catch { /* the marker goes at the end */ }
    if (!connection.authorization.valid) return;
    handedOver = true;
    await handleChatMessage(host, ws, {
      authorization: connection.authorization,
      text: composeHandoffText(msg.text, references),
      attachments: [],
      providerId: destination.id,
      source: "handoff",
      ...(msg.client ? { client: msg.client } : {}),
      ...(msg.requestId ? { requestId: msg.requestId } : {}),
      ...(msg.draftId ? { draftId: msg.draftId } : {}),
      ...(msg.thinkingLevel !== undefined ? { thinkingLevel: msg.thinkingLevel } : {}),
      handoffHooks: {
        onNamed: (sessionId) => {
          entry.sessionId = sessionId;
          if (!catalog.recordHandoff!(sessionId, handoff.handoffId, handoff.sourceSessionId, sourceMessages)) {
            host.log.emit({
              severityText: "WARN",
              body: "handoff link not recorded",
              attributes: { "session.id": sessionId, "handoff.id": handoff.handoffId },
            });
          }
        },
        onSettled: release,
      },
    });
  } catch (err) {
    if (!handedOver) refuse(host, ws, msg, err instanceof Error ? err.message : "The new chat couldn't be started.");
    else host.log.emit({ severityText: "ERROR", body: "handoff creation failed", attributes: { "handoff.id": handoff.handoffId, error: err instanceof Error ? err.message : String(err) } });
  } finally {
    if (!handedOver) release();
  }
}

/** Answer what became of a handoff key, without creating anything. */
export function handoffStatus(host: WsHost, ws: WSContext, handoffId: string): void {
  let sessionId: string | null = null;
  try { sessionId = host.catalog.findHandoff?.(handoffId) ?? null; }
  catch { /* unreadable: fall through to the in-memory answer */ }
  const pending = host.coordinator.handoffs.get(handoffId);
  sessionId ??= pending?.sessionId ?? null;
  host.sendMessage(ws, {
    type: "handoff_receipt",
    handoffId,
    state: sessionId ? "created" : pending ? "pending" : "none",
    ...(sessionId ? { sessionId } : {}),
  });
}

/** The prompt the summarizer reads: the snapshot as a plain transcript, newest kept. */
export function handoffTranscript(messages: readonly SessionHistoryMessage[], budget = HANDOFF_TRANSCRIPT_BUDGET_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const content = message.content.trim();
    if (!content) continue;
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${content}`;
    if (used + line.length > budget) {
      if (lines.length === 0) lines.unshift(line.slice(line.length - budget));
      break;
    }
    lines.unshift(line);
    used += line.length + 2;
  }
  return lines.join("\n\n");
}

/** Abort every preparation a closing connection started; nobody can read their result. */
export function abortHandoffPreparations(host: WsHost, owner: unknown): void {
  for (const [handoffId, preparation] of host.coordinator.handoffPreparations) {
    if (preparation.owner !== owner) continue;
    preparation.abort.abort();
    host.coordinator.handoffPreparations.delete(handoffId);
  }
}

export function cancelHandoffPreparation(host: WsHost, handoffId: string, owner: unknown): void {
  const preparation = host.coordinator.handoffPreparations.get(handoffId);
  if (preparation && preparation.owner === owner) preparation.abort.abort();
}

/**
 * Draft a handoff summary with one run on the source session's backend.
 * Never throws; the requesting connection always gets one `handoff_draft`.
 */
export async function prepareHandoff(
  host: WsHost,
  ws: WSContext,
  msg: ClientHandoffPrepare,
  connection: ConnectionState
): Promise<void> {
  const { coordinator, catalog } = host;
  const answer = (frame: Omit<Extract<ServerMessage, { type: "handoff_draft" }>, "type" | "handoffId">) => {
    if (!connection.closed) host.sendMessage(ws, { type: "handoff_draft", handoffId: msg.handoffId, ...frame });
  };
  if (coordinator.handoffPreparations.has(msg.handoffId)) {
    return answer({ state: "failed", message: "A summary for this handoff is already being drafted." });
  }
  const sourceBackendId = catalog.getStoredBackendId(msg.sourceSessionId);
  if (!sourceBackendId) return answer({ state: "failed", message: "This chat isn't known to this server." });
  if (coordinator.running.size + coordinator.startingSessions + coordinator.handoffPreparations.size >= host.maxConcurrentSessions()) {
    return answer({ state: "failed", message: "The server is busy, so no summary was drafted." });
  }
  const abort = new AbortController();
  coordinator.handoffPreparations.set(msg.handoffId, { abort, owner: connection });
  const releaseAuthorization = connection.authorization.retain();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, HANDOFF_PREPARATION_TIMEOUT_MS);
  let recorder: TurnRecorder | undefined;
  let outcome: "success" | "error" | "cancelled" | "timeout" = "error";
  try {
    const backend = await host.registry.getBackendForSession(sourceBackendId);
    if (backend.capabilities.autonomous !== true) {
      return answer({ state: "failed", message: `${backend.id} can't draft a summary on this server.` });
    }
    let history: SessionHistoryMessage[];
    try {
      history = host.prepareHistory(msg.sourceSessionId, await backend.getHistory(msg.sourceSessionId));
    } catch {
      return answer({ state: "failed", message: "Couldn't load this chat's history." });
    }
    const transcript = handoffTranscript(history.slice(0, msg.messageCount));
    if (!transcript) return answer({ state: "failed", message: "There is nothing in this chat to summarize yet." });
    if (abort.signal.aborted) { outcome = "cancelled"; return answer({ state: "cancelled" }); }
    host.expireAuthorizationContexts();
    if (!connection.authorization.valid) return;

    const profileId = catalog.getStoredProviderId(msg.sourceSessionId) ?? undefined;
    const billing = await resolveRunBilling(host.registry, backend.id, profileId);
    const runId = crypto.randomUUID();
    recorder = host.activity
      ? createTurnRecorder(
          {
            store: host.activity.store,
            ...(host.activity.runtime ? { runtime: host.activity.runtime } : {}),
            onWrite: () => host.activity!.stream.pump(),
            log: host.log,
          },
          {
            turnId: runId,
            sessionId: msg.sourceSessionId,
            principalId: connection.authorization.principalId,
            name: HANDOFF_PREPARATION_RUN_NAME,
            ...billing,
          }
        )
      : undefined;
    let text = "";
    let costUsd: number | undefined;
    let failed: string | undefined;
    const bridge: BackendBridge = {
      emit: (frame) => {
        if (frame.type === "session_info") return; // nonpersistent: never a session
        recorder?.observeFrame(frame);
        if (frame.type === "text_delta") text += frame.text;
        if (frame.type === "result") {
          if (typeof frame.costUsd === "number") costUsd = frame.costUsd;
          if (frame.outcome === "error" || (frame.outcome === undefined && frame.isError)) failed = frame.failure?.message ?? "The summary run failed.";
        }
        if (frame.type === "error") failed = frame.message;
      },
      activity: (event) => recorder?.observeActivity(event),
      // Toolless by construction; anything that asks is refused, never parked.
      checkpointPermission: () => {},
      requestPermission: async () => ({ behavior: "deny", message: "A handoff summary uses no tools." }),
      askUser: async () => { throw new Error("A handoff summary asks no questions."); },
    };
    try {
      await backend.startTurn({
        prompt: `Summarize this conversation for the handoff.\n\n<conversation>\n${transcript}\n</conversation>`,
        ...(profileId ? { profileId } : {}),
        signal: abort.signal,
        bridge,
        autonomous: {
          origin: "autonomous",
          persistence: "none",
          allowedTools: [],
          systemPromptAppend: SUMMARY_SYSTEM_PROMPT,
        },
        enforceAllowedTools: true,
        noGrantSurface: true,
      });
    } catch (err) {
      failed ??= err instanceof Error ? err.message : String(err);
    }
    if (costUsd !== undefined) catalog.addSessionCost?.(msg.sourceSessionId, costUsd);
    if (abort.signal.aborted) {
      outcome = timedOut ? "timeout" : "cancelled";
      return answer(timedOut
        ? { state: "failed", runId, message: "The summary took too long.", ...(costUsd !== undefined ? { costUsd } : {}) }
        : { state: "cancelled", runId, ...(costUsd !== undefined ? { costUsd } : {}) });
    }
    const summary = text.trim().slice(0, HANDOFF_MAX_CHARS);
    if (failed || !summary) {
      outcome = "error";
      return answer({ state: "failed", runId, message: failed ?? "The summary came back empty.", ...(costUsd !== undefined ? { costUsd } : {}) });
    }
    outcome = "success";
    return answer({ state: "ready", text: summary, runId, ...(costUsd !== undefined ? { costUsd } : {}) });
  } catch (err) {
    answer({ state: "failed", message: err instanceof Error ? err.message : "The summary couldn't be drafted." });
  } finally {
    clearTimeout(timer);
    recorder?.finish(outcome);
    releaseAuthorization();
    const current = coordinator.handoffPreparations.get(msg.handoffId);
    if (current?.abort === abort) coordinator.handoffPreparations.delete(msg.handoffId);
  }
}
