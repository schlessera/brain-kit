/**
 * The extraction classifier at one turn's admission (#4088), behind
 * `taint.classifier: heuristics`. The design and measurement are in
 * `docs/plans/extraction-classifier.md`; the heuristics themselves are pure
 * (`classify`, `packages/ui-server/src/governance/extraction-classifier.ts`).
 *
 * It sits on the bridge's per-call admission (`inputSafety.begin`), which
 * every backend awaits with the call's full input before running it, and on
 * its result (`inputSafety.result`), where the files the session read and the
 * content that tainted it are seen. Once the session is tainted:
 *
 * - `block` refuses the call. The reason is the refusal's text, and so the
 *   call's own tool result: the only verdict text the model ever sees.
 * - `ask` raises a per-use card naming the reason, for any call. A turn with
 *   no grant surface refuses instead.
 * - `allow` relaxes the #3430 tainted-destination card, and only that, for
 *   the hosts a readable call names while it is in progress (`relaxes`). Any
 *   opaque or unattributable call in progress withholds it: the proxy cannot
 *   tell which process opened a connection.
 *
 * Deny, `allowlist` mode, budgets and outward-action cards are decided
 * elsewhere and never consult it. Its session state is in-memory host state,
 * never written to the record or the provider-facing conversation.
 */
import { prepareOutwardPlan } from "@schlessera/brain-ui-sdk/internal";
import { requestToolPermission, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { inputTaintSignals, outputTaintSignals } from "../activity/ingestion-taint.js";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import { ExtractionSession, callInput, classify, localTool, namedHosts, readPath, readText, type ToolClass, type Verdict } from "../governance/extraction-classifier.js";

type InputSafety = NonNullable<BackendBridge["inputSafety"]>;

/** Sessions whose state this process holds, most recently used last. A session not here has incomplete state. */
const sessions = new Map<string, ExtractionSession>();
const SESSION_CAPACITY = 256;
function remember(id: string, state: ExtractionSession): void {
  sessions.delete(id); sessions.set(id, state);
  while (sessions.size > SESSION_CAPACITY) sessions.delete(sessions.keys().next().value!);
}

/** The refusal a blocked call's tool result carries. */
function extractionRefusal(tool: string, reason: string, cause: string | null): string {
  return `Refused: this ${tool} call ${reason}${cause ? `, and this session ${cause}` : ""}. Nothing was sent.`;
}

/** The per-use card a call the classifier asks about raises. */
function extractionCardDescription(tool: string, reason: string, cause: string | null, newHosts: readonly string[]): string {
  const lead = cause ? `This session ${cause}, so content you did not write may be steering it.` : "This session read content you did not write, which may be steering it.";
  return `${lead} This ${tool} call ${reason}. Allow it to run?`
    + (newHosts.length ? ` Allowing lets it send data to ${newHosts.join(", ")} for the rest of this session without asking again.` : "");
}

/** A call in progress: the hosts it relaxes, the hosts it names, and whether the proxy can attribute its connections at all. */
interface Call { relax: readonly string[]; hosts: readonly string[]; withholds: boolean }

/** The command policy's class of a call, and whether its connections are the hosts it names. */
function classOf(tool: string, input: unknown): { toolClass: ToolClass; readable: boolean; attributable: boolean } {
  if (tool === "WebFetch" || tool === "fetch_content") return { toolClass: "read", readable: true, attributable: true };
  if (tool === "Bash" || tool === "bash") {
    // The command policy's own classification of this input, with no rule applied.
    const classification = prepareOutwardPlan({ toolName: tool, shellToolName: tool, input }).classification;
    if (classification.opaque || classification.kind === "unknown") return { toolClass: "opaque", readable: false, attributable: false };
    // A curl or wget write is an outward action with its own card, scored as
    // the spike did (a writing method to a named host); only a visible read relaxes.
    const outward = classification.actions.some(action => action.action !== "http_write");
    return { toolClass: outward ? "outward" : "read", readable: classification.kind === "read", attributable: true };
  }
  // brain-kit's own tools open no connection; any other tool's connections
  // cannot be attributed, so it withholds the relaxation while it runs.
  return { toolClass: "read", readable: false, attributable: localTool(tool) };
}

export function createTurnExtraction(options: {
  bridge: BackendBridge; origin: "interactive" | "voice";
  sessionId: () => string | null;
  /** The session is tainted now. */
  tainted: () => boolean;
  /** Hosts this session reached, from earlier turns and this one. */
  contacted: ReadonlySet<string>;
  /** What tainted the session, as "This session …" completes it. */
  cause: () => string | null;
  brainPath?: string;
  marked?: (path: string) => boolean;
}) {
  const initialId = options.sessionId();
  // A new conversation's state is complete from its first call. A resumed one
  // is complete only if this process kept it from its first turn.
  const state = initialId === null ? new ExtractionSession(true) : sessions.get(initialId) ?? new ExtractionSession(false);
  let bound = initialId;
  /** The session's state, kept under its id once the conversation is named. */
  const session = () => {
    bound ??= options.sessionId();
    if (bound !== null) remember(bound, state);
    return state;
  };
  session();
  const calls = new Map<string, Call>();
  const verdicts = new Map<string, { input: string; outcome: Promise<Call> }>();
  const brainPath = (path: string) => {
    if (!options.brainPath) return false;
    const root = posix.normalize(options.brainPath).replace(/\/$/, ""), absolute = posix.resolve(root, path);
    return isWithin(root, absolute, { includeRoot: false }) && existsSync(absolute);
  };
  const end = (toolUseId: string) => { calls.delete(toolUseId); verdicts.delete(toolUseId); };

  const judge = async (tool: string, input: Readonly<Record<string, unknown>>): Promise<Call> => {
    const { toolClass, readable, attributable } = classOf(tool, input);
    const current = session();
    if (!options.tainted()) return { relax: [], hosts: [], withholds: !attributable };
    current.freezeInitial(options.contacted);
    const verdict: Verdict = classify(callInput(tool, input, toolClass), { session: current, contacted: host => options.contacted.has(host), brainPath });
    const hosts = verdict.request.route === "network" ? verdict.request.hosts : [];
    const call: Call = { relax: [], hosts, withholds: !attributable };
    const relaxable = readable && options.origin === "interactive" && hosts.length > 0;
    if (verdict.band === "block") throw new Error(extractionRefusal(tool, verdict.reason ?? "looks like it carries data out of this session", options.cause()));
    if (verdict.band === "ask") {
      const reason = verdict.reason ?? "looks like it carries data out of this session";
      // Voice has no grant surface: it refuses wherever an interactive turn would ask.
      if (options.origin !== "interactive") throw new Error(extractionRefusal(tool, reason, options.cause()));
      const fresh = hosts.filter(host => !options.contacted.has(host));
      const decision = await requestToolPermission(options.bridge, { toolUseId: crypto.randomUUID(), toolName: tool, kind: "command",
        input: { ...(verdict.request.surface === "web_fetch" ? { url: input.url } : verdict.request.surface === "bash" || verdict.request.surface === "brain_cli" ? { command: input.command } : {}), hosts },
        description: extractionCardDescription(tool, reason, options.cause(), fresh),
      }).catch(() => ({ behavior: "deny" as const, message: "The card could not be shown." }));
      if (decision.behavior !== "allow") throw new Error(`Refused: the user declined this ${tool} call, which ${reason}. Nothing was sent.`);
      // The user saw this call and its hosts: its connections need no second card.
      return { ...call, relax: relaxable ? hosts : [] };
    }
    // An incomplete state may have missed a read, so it never allows.
    return { ...call, relax: relaxable && current.complete ? hosts : [] };
  };

  /** Each call's input, from its admission to its result. */
  const inputs = new Map<string, unknown>();
  const wrap = (safety: InputSafety): InputSafety => ({ ...safety,
    async begin(toolUseId, tool, input) {
      await safety.begin(toolUseId, tool, input);
      inputs.set(toolUseId, input);
      const key = JSON.stringify(input) ?? "";
      // A call admitted through two gates is judged, and asked about, once.
      let prior = verdicts.get(toolUseId);
      if (!prior || prior.input !== key) {
        prior = { input: key, outcome: judge(tool, input) };
        verdicts.set(toolUseId, prior);
      }
      try { calls.set(toolUseId, await prior.outcome); }
      catch (error) { end(toolUseId); throw error; }
    },
    async result(toolUseId, tool, output, finalized, segments) {
      const input = inputs.get(toolUseId);
      end(toolUseId); inputs.delete(toolUseId);
      try { await safety.result(toolUseId, tool, output, finalized, segments); }
      finally { observe(tool, input, output); }
    },
    refused(toolUseId, denied) { end(toolUseId); inputs.delete(toolUseId); return safety.refused?.(toolUseId, denied) ?? Promise.resolve(); },
  });
  /** The name a reason gives a file: brain-relative when it is in the brain. */
  const display = (path: string) => {
    if (!options.brainPath || !path.startsWith("/")) return posix.normalize(path).replace(/^\.\//, "");
    const root = posix.normalize(options.brainPath).replace(/\/$/, ""), absolute = posix.normalize(path);
    return isWithin(root, absolute, { includeRoot: false }) ? absolute.slice(root.length + 1) : absolute;
  };
  /** What the session read, and what its tainting content named. Never fails the call it observes. */
  const observe = (tool: string, input: unknown, output: string) => {
    try {
      const current = session();
      const path = readPath(tool, input);
      if (path !== null) current.read(display(path), readText(output));
      // Content from anywhere the host cannot vouch for: a fetch, a command
      // (its connections taint the session at the proxy), another MCP server,
      // an untrusted area or a marked file.
      const tainting = !localTool(tool) || inputTaintSignals(tool, input, options.brainPath, options.marked, true).length > 0
        || outputTaintSignals(tool, output, options.brainPath, options.marked).length > 0;
      if (tainting) current.tainting(namedHosts(output));
    } catch { state.complete = false; }
  };
  return {
    /** The bridge's admission, with the classifier on it. Absent when the bridge has none: then nothing is classified or relaxed. */
    inputSafety(safety: InputSafety | undefined): InputSafety | undefined {
      return safety ? wrap(safety) : undefined;
    },
    /** A tool result ends its call, as `inputSafety.result` does. */
    emitted(message: Parameters<BackendBridge["emit"]>[0]): void {
      if (message.type === "tool_result") end(message.toolUseId);
    },
    /**
     * Whether an `allow` (or a card the user approved) covers a connection to
     * `host` now: some call in progress relaxes it, every call in progress is
     * attributable, and no call in progress names it without relaxing it.
     */
    relaxes(host: string): boolean {
      const active = [...calls.values()];
      if (active.some(call => call.withholds)) return false;
      return active.some(call => call.relax.includes(host)) && active.every(call => !call.hosts.includes(host) || call.relax.includes(host));
    },
  };
}
