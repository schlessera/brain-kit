import { AGENT_INFERENCE_CREDENTIAL_ENV, INFERENCE_PLACEHOLDER, WORKER_EGRESS_DIR, workerProviderCredentials } from "@schlessera/brain-ui-sdk/internal";
import { promptPrefixFingerprint } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeTitleUsageCollector } from "./title-usage.js";
import { toolAvailabilityRefusal } from "./tool-availability.js";
import { claudePromptContext, acknowledgeClaudeContext } from "./prompt-context.js";
import { describeClient } from "@schlessera/brain-ui-sdk/internal";
import { autonomousSystemPrompt } from "./autonomous-prompt.js";
import { ASK_USER_FORM_TOOL_NAME } from "./ask-user-form-tool.js";
import type {
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatImageAttachment,
  ClientEnvironment,
  StartTurnRequest,
  TurnFailure,
} from "@schlessera/brain-ui-sdk/server";
import { buildSystemPromptAppend } from "@schlessera/brain-ui-sdk/server";
import { RTK_WORKER_ENV, workerOutwardNote, workerCommandPolicyNote, prepareWorkerSandbox, prepareWorkerSandboxAsync, workerSandboxNote, workerSandboxWarnings, WORKER_SCRATCH, WORKER_STATE, WORKER_XDG_DIRS,
  outputStagingLimit, turnTempLimit, type TurnTempAccess } from "@schlessera/brain-ui-sdk/internal";
import { isThinkingLevel, stateRoomCopy, stateRoomWarning } from "@schlessera/brain-ui-sdk/protocol";
import { QUERY_ACTIVITY_TOOL_NAME } from "./activity-tool.js";
import { APIFY_TOOL_NAMES, COMPUTE_TOOL_CONTRACTS, READ_ATTACHMENT_TOOL_NAME, visibleToolName } from "@schlessera/brain-ui-sdk/server";
import { createBrainUiMcpServer, ASK_USER_TOOL_NAME } from "./ask-user-tool.js";
import { ASK_USER_LIST_TOOL_NAME } from "./ask-user-list-tool.js";
import { ASK_USER_RANK_TOOL_NAME } from "./ask-user-rank-tool.js";
import { envSnapshot, ambientExecConfig, operatorAdmittedEnvNames } from "./config/env.js";
import { GET_LOCATION_TOOL_NAME } from "./location-tool.js";
import { MASK_TOOL_NAME } from "./mask-tool.js";
import { userMessage } from "./turn-input.js";
import { SHOW_BLOCK_TOOL_NAME } from "./show-block-tool.js";
import type { BackendLogFn, ClaudeBackendOptions } from "./options.js";
import type { InferenceProfile } from "./profiles.js";
import { createPermissionWiring } from "./permission-hooks.js";
import { CLAUDE_INFERENCE_ENV, createWorkerSpawn } from "./worker-spawn.js";
import { launchLimits, resolveTurnTempLimits, resolveWorkerStateLimits, workerNoteLimits, type WorkerLimitReport } from "@schlessera/brain-ui-sdk/internal";
import { createTurnTempPressureHook, createTurnTempTool, TURN_TEMP_TOOL_NAME } from "./turn-temp-tool.js";
import { workerStateLimit } from "./worker-state.js";
import { claudeAutonomousEnvelope } from "./autonomous-envelope.js";
import { claudeEffort } from "./effort.js";
import { CLEARED_API_CREDENTIALS, NEUTRALISED_SETTINGS } from "./subscription.js";
import { RELAYED_TURN_SETTINGS, RELAYED_TURN_TRAFFIC_ENV, telemetryConfigured } from "./relayed-turn-traffic.js";
import type { TurnLockBinding } from "./turn-lock.js";

/**
 * The in-worker brain MCP server's compute tools (#3107). A hosted turn
 * reaches external compute only through the host's `mcp__brain-ui__brain_compute_*`
 * tools, which bind its caller, policy, approval and credentials; the worker
 * copies would admit without any of them. Disallowed in every session, so the
 * tool list never depends on configuration (provider-history.md).
 */
export const IN_WORKER_COMPUTE_TOOLS: readonly string[] = Object.freeze(COMPUTE_TOOL_CONTRACTS.map(contract => `mcp__brain__${contract.name}`));
/** The prompt-brief keys of the compute contracts, as `SurfaceTools` names them. */
const COMPUTE_SURFACE_KEYS = [["computeHealth", "brain_compute_health"], ["computePlan", "brain_compute_plan"], ["computeRun", "brain_compute_run"],
  ["computeStatus", "brain_compute_status"], ["computeCancel", "brain_compute_cancel"], ["computeCollect", "brain_compute_collect"]] as const;

export interface ClaudeSdkTurn {
  options: Options;
  prompt: string | AsyncIterable<SDKUserMessage>;
  /**
   * The turn is held to the subscription (subscription.ts): its prompt may be
   * released only after the account the CLI selected has been checked.
   */
  subscriptionOnly: boolean;
  /** Flag-settings env values the host pinned itself; the settings check accepts exactly these. */
  pinnedSettingsEnv?: Readonly<Record<string, string>>;
  finishWorker(): Promise<void>;
  /** The resource limits this turn's workers hit (#1660): so far, and once they have exited. */
  workerLimits: { current(): WorkerLimitReport; settled(): Promise<WorkerLimitReport> };
  /** A worker-state refusal or stop (#1625), reported as the turn's failure. */
  workerFailure(): TurnFailure | undefined;
  /** Why an ordinary worker did not start (#2790): the error its spawn once threw to the SDK. */
  workerStartFailure(): unknown;
  workerStateRoom(): import("@schlessera/brain-ui-sdk/protocol").StateRoomObservation | undefined;
  /** Each streamed piece of the answer, for the turn-temp purge's linked-file guard (#1703). */
  observeAnswerText(text: string): void;
}

/**
 * One environment for everything a turn on `profile` spawns: the profile's
 * declared credential names are part of the agent audience (config/env.ts),
 * and the rtk hook shells out before the SDK does, so both must see the same
 * filtered set rather than the server's own. The boot probe uses it too.
 */
export function turnEnv(profile: InferenceProfile): Record<string, string | undefined> {
  const env = { ...envSnapshot(profile.requiredEnvKeys), ...profile.buildEnv(), ...RTK_WORKER_ENV };
  // After the profile's own env, so nothing a profile builds can put an API
  // credential back under a turn that is not declared as API-billed.
  if (profile.billing !== "api") Object.assign(env, CLEARED_API_CREDENTIALS);
  return env;
}

/**
 * The route the server selects for a turn: the profile's baseUrl (built into
 * its environment), else the host's `ANTHROPIC_BASE_URL`, else first-party
 * inference. Turn admission names the recipient from its origin (#2695).
 */
export function selectedInferenceUpstream(turnEnvironment: Readonly<Record<string, string | undefined>> | undefined): string {
  return (turnEnvironment?.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
}

interface ClaudeSdkTurnOptions {
  identity?: import("@schlessera/brain-ui-sdk/internal").WorkerNoteFacts["identity"];
  backend: ClaudeBackendOptions;
  /** One resolved environment selects both host observation storage and native runtime state. */
  turnEnvironment?: Record<string, string | undefined>;
  /** Concrete host-prepared transport only; ordinary selection/route/lifetime are owned by its caller. */
  hostInference?: { proxyDir: string; baseUrl?: string;
    /** An API-billed profile's placeholders; absent for the host Claude login. */
    placeholders?: Readonly<Record<string, string>> };
  fileVersions?: import("@schlessera/brain-ui-sdk/internal").NativeFileVersions;
  req: StartTurnRequest;
  profile: InferenceProfile;
  abortController: AbortController;
  allowedTools: readonly string[];
  confirmPatterns: readonly RegExp[];
  turnLock: TurnLockBinding;
  log: BackendLogFn;
}

export function createClaudeSdkTurn(options: ClaudeSdkTurnOptions): ClaudeSdkTurn {
  if (options.hostInference && (options.req.autonomous || (options.profile.billing === "api") !== Boolean(options.hostInference.placeholders))) {
    throw new Error("The prepared Claude inference transport requires an ordinary turn and its profile's own credential placeholders.");
  }
  // An autonomous turn gets the restricted envelope (#676): only the relay
  // route out, a placeholder credential and no ambient project configuration.
  const envelope = options.req.autonomous?.containment === "restricted"
    ? claudeAutonomousEnvelope(options.profile, turnEnv(options.profile)) : undefined;
  try {
    const turn = assembleClaudeSdkTurn(options, envelope);
    if (options.req.autonomous) return turn;
    let collector: ReturnType<typeof createClaudeTitleUsageCollector> | undefined;
    const spawn = turn.options.spawnClaudeCodeProcess!;
    let attempted = false;
    turn.options.spawnClaudeCodeProcess = input => {
      if (!attempted) {
        attempted = true;
        // Respect operator telemetry and opt-outs in the actual launch env.
        // Merely assembling options never opens an observability listener.
        const configured = telemetryConfigured(input.env, options.hostInference
          ? options.turnEnvironment ?? turnEnv(options.profile) : undefined);
        if (!configured) {
          try {
            collector = createClaudeTitleUsageCollector();
            Object.assign(input.env, collector.env);
            Object.assign(turn.options.env ??= {}, collector.env);
          } catch { /* Observability unavailable: retain unknown coverage. */ }
        }
      }
      return spawn(input);
    };
    const finish = turn.finishWorker;
    let settled: Promise<void> | undefined;
    turn.finishWorker = () => settled ??= (async () => {
      try { await finish(); }
      finally {
        const evidence = collector?.snapshot() ?? { receipts: [], coverage: "unknown" as const };
        collector?.stop();
        try { options.req.bridge.activity?.({ kind: "claude_title_usage", ...evidence }); }
        catch { /* Observability must not fail the observed turn. */ }
      }
    })();
    return turn;
  }
  catch (error) { envelope?.relay.stop(); throw error; }
}

/** The bridge handlers a turn binds and the tools it auto-allows (#2519). */
export interface ClaudeToolRoster {
  askUser: StartTurnRequest["bridge"]["askUser"];
  askUserList: StartTurnRequest["bridge"]["askUserList"];
  askUserRank: StartTurnRequest["bridge"]["askUserRank"];
  askUserForm: StartTurnRequest["bridge"]["askUserForm"];
  getLocation: StartTurnRequest["bridge"]["getLocation"];
  requestMask: StartTurnRequest["bridge"]["requestMask"];
  proposePolicyChange: StartTurnRequest["bridge"]["proposePolicyChange"];
  queryActivity: StartTurnRequest["bridge"]["queryActivity"];
  /** Whether the turn registers its own size-limited /tmp tool. */
  turnTempTool: boolean;
  /** Whether the server owns application, so legacy writers migrate to its tools. */
  hosted: boolean;
  /** The SDK `allowedTools`, in the order the provider sees them. */
  allowed: string[];
}

export function computeToolRoster(req: StartTurnRequest, allowedTools: readonly string[]): ClaudeToolRoster {
  // Bind current handlers; interactive schema presence never grants authority.
  const askUser = req.bridge.askUser;
  const getLocation = req.bridge.getLocation;
  // The mask editor is the one bridge tool that needs EYES: it opens an editor
  // and then blocks on a region someone has to paint. A turn that declared it
  // has no grant surface has nobody to paint it, so its handler is withheld.
  // The full interactive schema stays registered; mandatory call-time hooks
  // refuse it before permission cards, including settings auto-allows. See
  // docs/decisions/voice-permission.md. Location, activity,
  // show_block and ask_user ask nothing of a viewer, so they are unaffected.
  const requestMask = req.noGrantSurface === true ? undefined : req.bridge.requestMask;
  // The list card needs eyes for the same reason: up to thirty rows of chips
  // that someone has to read and tap. It is not in the voice posture, so it is
  // withheld here rather than appended into an allowlist that left it out.
  const askUserList = req.noGrantSurface === true ? undefined : req.bridge.askUserList;
  const askUserRank = req.noGrantSurface === true ? undefined : req.bridge.askUserRank;
  const askUserForm = req.noGrantSurface === true ? undefined : req.bridge.askUserForm;
  const proposePolicyChange = !req.autonomous && !req.noGrantSurface && req.posture !== "voice" ? req.bridge.proposePolicyChange : undefined;
  const queryActivity = req.bridge.queryActivity;
  // Usage and purge of the worker's own size-limited /tmp (#1703): scoped to
  // it by the server's held descriptor, so it needs no approval. Not in the
  // restricted envelope, whose roster is exact server authority.
  const turnTempTool = !req.autonomous;
  const hosted = (!req.autonomous && req.applicationAuthority === "server") || Boolean(req.bridge.applyBrain);
  const migrations: Record<string, string> = {
    mcp__brain__brain_add: "mcp__brain-ui__brain_add", mcp__brain__brain_update: "mcp__brain-ui__brain_update",
    mcp__brain__brain_archive: "mcp__brain-ui__brain_archive", Write: "mcp__brain-ui__write_file", Edit: "mcp__brain-ui__edit_file",
  };
  // Registration is stable across interactive profiles/postures (#2048 A).
  // Native writers keep their auto-allow on governed typed turns; the hook
  // refuses them on strict/voice turns before any settings or remembered grant.
  // Keep server writers alongside the natives, with their existing authority.
  const allowed = [...new Set(allowedTools.flatMap(name => {
    if (!hosted) return [name];
    const migrated = migrations[name] ?? name;
    return !req.autonomous && (name === "Write" || name === "Edit") ? [name, migrated] : [migrated];
  }))];
  if (req.bridge.readBrainBase) allowed.push("mcp__brain-ui__brain_read_base");
  // Application permission lives in the server. These are callable tools,
  // never authority: every executor goes through the server-owned route.
  if (req.bridge.applyBrain && !req.noGrantSurface) allowed.push(
    "mcp__brain-ui__brain_archive", "mcp__brain-ui__apply_staged_changes");
  // An autonomous roster is exact server authority, including bridge tools.
  if (!req.autonomous) {
    // Auto-allow the in-process MCP tools so they never trip a permission
    // prompt (ask-user is itself the question channel; location consent is
    // handled by the browser's geolocation prompt).
    if (askUser) allowed.push(ASK_USER_TOOL_NAME);
    if (askUserList) allowed.push(ASK_USER_LIST_TOOL_NAME);
    if (askUserRank) allowed.push(ASK_USER_RANK_TOOL_NAME);
    if (askUserForm) allowed.push(ASK_USER_FORM_TOOL_NAME);
    if (getLocation) allowed.push(GET_LOCATION_TOOL_NAME);
    // Auto-allowed like the other bridge tools: the approval is the editor
    // itself — nothing happens unless the user paints and confirms.
    if (requestMask) allowed.push(MASK_TOOL_NAME);
    // Read-only over the host's own record — strictly narrower than the
    // file/tool access the model already has.
    if (queryActivity) allowed.push(QUERY_ACTIVITY_TOOL_NAME);
    if (turnTempTool) allowed.push(TURN_TEMP_TOOL_NAME);
    for (const [name, handler] of [["inbox_list", "inboxList"], ["inbox_get", "inboxGet"]] as const) if (req.bridge[handler]) allowed.push(visibleToolName(name, "claude"));
    if (!req.noGrantSurface && req.posture !== "voice") for (const [name, handler] of [["inbox_add", "inboxAdd"], ["resolve_action", "resolveAction"], ["complete_share", "completeShare"]] as const) if (req.bridge[handler]) allowed.push(visibleToolName(name, "claude"));
    // The host owns reference authority and refuses per call (#2432); an
    // approval card would add nothing a grant does not already decide.
    if (req.bridge.referenceAccess) allowed.push(visibleToolName("reference_source", "claude"), visibleToolName("reference_worktree", "claude"));
    // External compute (#3108): the host decides authority and shows its own
    // per-use approval card for a run, so a runtime card would ask twice.
    if (req.bridge.compute) allowed.push(...COMPUTE_TOOL_CONTRACTS.map(contract => visibleToolName(contract.name, "claude")));
    // Apify (#3162): the host decides every call and asks per exact run; a
    // tool-level card would add a rememberable grant that authorizes nothing.
    if (req.bridge.apify && !req.noGrantSurface && req.posture !== "voice") allowed.push(...Object.values(APIFY_TOOL_NAMES).map(name => visibleToolName(name, "claude")));
    // Attachment reads (#3154): the host authorizes each id against this
    // session's own references; a card would ask to read what the user sent.
    if (req.bridge.readAttachment) allowed.push(visibleToolName(READ_ATTACHMENT_TOOL_NAME, "claude"));
    // No side effect and no host handler: the block is part of the answer, and
    // an approval card for drawing a table would be the surface asking
    // permission to answer.
    allowed.push(SHOW_BLOCK_TOOL_NAME);
  }
  return { askUser, askUserList, askUserRank, askUserForm, getLocation, requestMask, proposePolicyChange, queryActivity, turnTempTool, hosted, allowed };
}

/** The environment a turn's subprocesses run with, and the provider keys its worker keeps. */
export function turnChildEnvironment(
  options: Pick<ClaudeSdkTurnOptions, "turnEnvironment" | "hostInference" | "profile">,
  envelope: ReturnType<typeof claudeAutonomousEnvelope> | undefined
) {
  const { profile } = options;
  const inheritedEnv = envelope?.env ?? options.turnEnvironment ?? turnEnv(profile);
  // Only the explicitly selected internal transport changes inference auth.
  // Other provider/command environment compatibility remains #1666 work.
  const inferenceEnv = options.hostInference ? {
    ...CLEARED_API_CREDENTIALS,
    ...(options.hostInference.placeholders ?? { CLAUDE_CODE_OAUTH_TOKEN: INFERENCE_PLACEHOLDER }),
    ANTHROPIC_UNIX_SOCKET: `${WORKER_EGRESS_DIR}/inference.sock`,
    ANTHROPIC_BASE_URL: options.hostInference.baseUrl ?? "http://localhost",
    ...RELAYED_TURN_TRAFFIC_ENV,
  } : undefined;
  // The relay holds the profile's credential, so the variables it names stay on the host.
  const childEnv = inferenceEnv ? { ...Object.fromEntries(Object.entries(inheritedEnv)
    .filter(([name]) => !profile.requiredEnvKeys.includes(name)
      // An operator who admits an agent-only key explicitly keeps it.
      && !(AGENT_INFERENCE_CREDENTIAL_ENV.includes(name) && !operatorAdmittedEnvNames().includes(name)))), ...inferenceEnv } : inheritedEnv;
  // The provider keys a governed or strict worker keeps (#1666): the Claude
  // CLI's own inference variables (placeholders on a relayed turn), the
  // profile's declared credential and what an operator admits. The launcher
  // withholds every other provider key, and the note names what stays.
  const credentialEnv = [...CLAUDE_INFERENCE_ENV, ...profile.requiredEnvKeys, ...operatorAdmittedEnvNames()];
  const providerKeys = workerProviderCredentials(childEnv, credentialEnv).kept.filter(name => !inferenceEnv || !(name in inferenceEnv));
  return { inferenceEnv, childEnv, credentialEnv, providerKeys };
}

/** The worker's writable areas and limits, and the note the agent reads about them. */
function prepareSandboxNote(
  options: ClaudeSdkTurnOptions,
  envelope: ReturnType<typeof claudeAutonomousEnvelope> | undefined,
  providerKeys: string[],
  turnTempTool: boolean
) {
  const { backend, req, confirmPatterns, log } = options;
  // One resolution of the worker's writable areas feeds both its mounts and
  // the note the agent reads, so the two cannot disagree (#1626).
  const sandbox = envelope ? { ...prepareWorkerSandbox(backend.brainPath, { restricted: true, maintenance: backend.maintenance }),
    ...(req.workerProviderMasks ? { providerMasks: req.workerProviderMasks } : {}), ...(req.workerDataTree ? { dataTree: req.workerDataTree } : {}) }
    : req.workerSandbox ?? prepareWorkerSandbox(backend.brainPath, { maintenance: backend.maintenance });
  for (const warning of workerSandboxWarnings(sandbox)) log("warn", warning);
  // The same for its resource limits (#1660).
  const limits = launchLimits({});
  // The runtime-state allowance is one of the stated limits, from the same
  // resolved value the worker's tmpfs is mounted with (#1625).
  const stateLimits = resolveWorkerStateLimits(backend.workerState ?? {});
  // And so is turn temp's, next to the tool that frees it (#1703).
  const turnTempLimits = resolveTurnTempLimits(backend.turnTemp ?? {});
  const sandboxNote = [workerSandboxNote(sandbox, { ...(options.identity ? { identity: options.identity } : {}), ...(options.hostInference ? { egress: true } : {}), providerKeys, hardTimeoutMs: req.turnBudgetMs, limits: [...workerNoteLimits(limits.status), workerStateLimit(stateLimits),
    turnTempLimit(turnTempLimits.allowanceBytes, turnTempTool ? TURN_TEMP_TOOL_NAME : undefined),
    outputStagingLimit()] }), workerCommandPolicyNote(req.autonomous ? undefined : sandbox.commandPolicy, confirmPatterns), req.autonomous ? "" : workerOutwardNote(Boolean(options.hostInference), sandbox.commandPolicy?.taint?.())].filter(Boolean).join("\n\n");
  return { sandbox, limits, stateLimits, turnTempLimits, sandboxNote };
}

/**
 * The system prompt append and, for an interactive turn, the prompt context
 * its first user message carries (#2519). The append is snapshotted once per
 * session; live facts travel only on the new user message.
 */
export function assemblePromptContext(
  backend: ClaudeBackendOptions,
  req: StartTurnRequest,
  roster: ClaudeToolRoster,
  sandbox: NonNullable<StartTurnRequest["workerSandbox"]>,
  sandboxNote: string
) {
  const { askUser, askUserList, askUserRank, askUserForm, getLocation, requestMask, proposePolicyChange, queryActivity, turnTempTool } = roster;
  const brief = req.autonomous?.systemPromptAppend ?? buildAppend(
    backend,
    req.client,
    {
      policyChange: Boolean(proposePolicyChange),
      askUser: Boolean(askUser),
      askUserList: Boolean(askUserList),
      askUserRank: Boolean(askUserRank),
      askUserForm: Boolean(askUserForm),
      location: Boolean(getLocation),
      mask: Boolean(requestMask),
      activity: Boolean(queryActivity),
      inbox: Boolean(req.bridge.inboxList),
      block: true,
      turnTemp: turnTempTool,
      reference: Boolean(req.bridge.referenceAccess),
      compute: Boolean(req.bridge.compute),
    },
    req.turnBudgetMs
  );
  const candidate = brief ? `${brief}\n\n${sandboxNote}` : sandboxNote;
  const contextId = req.sessionId ?? crypto.randomUUID();
  const context = req.autonomous ? undefined : claudePromptContext(backend.brainPath, contextId);
  const append = context ? context.retainAppend([buildAppend(backend, undefined, {
    policyChange: true, askUser: true, askUserList: true, askUserRank: true, askUserForm: true,
    location: true, mask: true, activity: true, inbox: true, block: true, turnTemp: true, reference: true, compute: true,
  }, undefined), req.sessionBudgetLimits].filter(Boolean).join("\n\n"), req.sessionBudgetLimits ? { limits: req.sessionBudgetLimits } : {}) : candidate;
  const available = (name: string) => toolAvailabilityRefusal({ ...req, workerSandbox: sandbox }, name) === undefined;
  const owned = context?.prepare(req.prompt, {
    device: req.client ? describeClient(req.client) : "Device unknown; hardware probe results are withheld until known.",
    sandbox: sandboxNote,
    capabilities: JSON.stringify({ posture: req.posture ?? "default", noGrantSurface: req.noGrantSurface === true,
      askUser: available("ask_user"), askUserList: available("ask_user_list"), askUserRank: available("ask_user_rank"), askUserForm: available("ask_user_form"),
      location: available("get_current_location"), mask: available("request_image_mask"), policyChange: available("propose_policy_change"),
      activity: available("query_activity"), inbox: { list: available("inbox_list"), get: available("inbox_get"),
        add: available("inbox_add"), resolveAction: available("resolve_action"), completeShare: available("complete_share") },
      reference: available("reference_source"), compute: available("brain_compute_run") }),
    ...(req.turnBudgetMs && req.turnBudgetMs > 0 ? { timeout: `The host hard budget for this turn is ${req.turnBudgetMs} ms (about ${Math.round(req.turnBudgetMs / 60000)} minutes); finish inside this cap.` } : {}),
    ...(req.sessionBudgetLimits ? { limits: req.sessionBudgetLimits } : {}),
    ...(req.budgetContext ? { budget: req.budgetContext } : {}),
  });
  return { contextId, context, append, owned };
}

function assembleClaudeSdkTurn(
  options: ClaudeSdkTurnOptions,
  envelope: ReturnType<typeof claudeAutonomousEnvelope> | undefined
): ClaudeSdkTurn {
  const { backend, req, profile, abortController, confirmPatterns, turnLock, log } = options;
  const roster = computeToolRoster(req, options.allowedTools);
  const { turnTempTool, hosted, allowed } = roster;
  const { inferenceEnv, childEnv, credentialEnv, providerKeys } = turnChildEnvironment(options, envelope);
  const { sandbox, limits, stateLimits, turnTempLimits, sandboxNote } = prepareSandboxNote(options, envelope, providerKeys, turnTempTool);
  const { contextId, context, append, owned } = assemblePromptContext(backend, req, roster, sandbox, sandboxNote);
  const subscriptionOnly = profile.billing !== "api";
  const sdkOptions: Options = {
    ...(req.autonomous ? { persistSession: false } : {}),
    // Only the server's own MCP server; no project .mcp.json, user or plugin
    // server. Tool membership stays the enforced roster, as in every posture:
    // an out-of-roster call escalates to a durable decision (AE3).
    ...(envelope ? { strictMcpConfig: true } : {}),
    cwd: backend.brainPath,
    includePartialMessages: true,
    // Forward subagent text/thinking tagged with parent_tool_use_id so
    // drill-in views get full transcripts. The adapter keeps this OFF the
    // chat surface (activity side channel only) — a regression here degrades
    // gracefully to activity-only subagent visibility.
    forwardSubagentText: true,
    abortController,
    // Load CLAUDE.md and project skills from the brain repo (not for a
    // restricted turn; see below).
    settingSources: ["project"],
    // The brain repo's CLAUDE.md says what the agent is working ON; this says
    // what it is rendering INTO. Interactive turns append to the preset;
    // restricted turns use the package-owned static prompt and boundary.
    systemPrompt: envelope ? autonomousSystemPrompt(allowed, sandboxNote) : {
      type: "preset",
      preset: "claude_code",
      snapshot: true,
      append,
    },
    // Preserve manual approvals across SDK versions that leave an omitted
    // mode to the CLI (claude-code-runtime.md, #1213). Enforcement hooks
    // remain the every-call boundary, including no-grant and voice turns.
    permissionMode: "default",
    allowedTools: allowed,
    // The built-in AskUserQuestion picker needs a TTY; keep it disabled even
    // when no ask-user handler is present.
    disallowedTools: ["AskUserQuestion", ...IN_WORKER_COMPUTE_TOOLS, ...((hosted || req.autonomous) ? [
      "mcp__brain__brain_add", "mcp__brain__brain_update", "mcp__brain__brain_archive",
    ] : []), ...(hosted && req.autonomous && (sandbox.profile !== "governed" || req.posture === "voice") ? ["Write", "Edit", "NotebookEdit"] : [])],
    ...createPermissionWiring({
      req: { ...req, workerSandbox: sandbox },
      denyNativeWrites: hosted && !req.autonomous && (sandbox.profile !== "governed" || req.posture === "voice"),
      allowedTools: allowed,
      confirmPatterns,
      brainPath: backend.brainPath,
      fileVersions: options.fileVersions,
      observeFile: path => worker.observeFile(path),
      rewriteRtk: command => worker.rewriteRtk(command),
      turnLock,
      childEnv,
      configurationRoot: () => worker.configurationRoot(),
      maintenance: backend.maintenance,
      log,
    }),
  };

  if (profile.model !== undefined) sdkOptions.model = profile.model;
  const effort = claudeEffort(profile, req.thinkingLevel);
  if (effort !== undefined) sdkOptions.effort = effort;
  if (req.thinkingLevel !== undefined) observeEffectiveEffort(sdkOptions, req);
  if (backend.claudeCodePath !== undefined) {
    sdkOptions.pathToClaudeCodeExecutable = backend.claudeCodePath;
  }
  // Every runtime-owned executor enters the worker. An optional host exec
  // wrapper runs inside it and can never replace the filesystem boundary.
  const worker = createWorkerSpawn(backend.brainPath, backend.exec ?? ambientExecConfig(), abortController.signal,
    envelope ? { inferenceDir: envelope.relay.dir } : undefined, sandbox, limits,
    // Files the answer links in turn temp are promoted into scratch and the
    // saved answer links the copies (#1655); a turn that saves nothing has no answer to keep.
    req.autonomous ? undefined : {
      turnId: req.turnId,
      report: records => {
        for (const record of records) {
          try { req.bridge.activity?.(record); } catch { /* Observability must not fail the observed turn. */ }
        }
      },
      log: (level, message) => log(level, message),
    }, { limits: stateLimits, turnTempLimits, reportCleanup: notice => req.bridge.activity?.({ kind: "worker_cleanup", ...notice }) }, req.workerLock, req.workerStarted, req.workerStartupView, req.persistClaudeMemory, options.hostInference, credentialEnv);
  sdkOptions.spawnClaudeCodeProcess = worker.spawn;
  if (!req.autonomous) addStateRoomWarning(sdkOptions, req, worker);
  /** This turn's answer text so far: what it links in turn temp is promoted, so a purge keeps it. */
  let answerText = "";
  const turnTemp: TurnTempAccess = {
    root: worker.turnTempRoot, allowanceBytes: worker.turnTempBytes, scratch: WORKER_SCRATCH,
    exclude: [WORKER_STATE], keep: [WORKER_SCRATCH, ...Object.values(WORKER_XDG_DIRS)],
    linkedText: () => answerText,
  };
  if (turnTempTool) addTurnTempPressure(sdkOptions, turnTemp);
  if (req.sessionId !== undefined) sdkOptions.resume = req.sessionId;
  else if (context) sdkOptions.sessionId = contextId;
  // Interactive schema membership is deployment-stable, even without a live
  // handler. The mandatory hook refuses unavailable calls; fallback tool
  // bodies also return model-readable errors instead of acquiring authority.
  let assembledTools: unknown[] | undefined;
  sdkOptions.mcpServers = { "brain-ui": turnMcpServer(backend, req, roster, turnTemp, tools => { assembledTools = tools; }) };
  sdkOptions.env = childEnv;
  applyTurnSettings(sdkOptions, envelope, subscriptionOnly, inferenceEnv);
  if (!req.autonomous) reportPromptPrefix(req, sdkOptions, assembledTools);

  // The selected relay origin makes the CLI coalesce custom system blocks.
  // Keep all per-item context in the user message, after the marked prefix.
  const prompt = envelope ? `${req.autonomous!.systemPromptAppend}\n\n${req.prompt}` : req.prompt;
  return {
    options: sdkOptions,
    subscriptionOnly,
    ...(envelope ? { pinnedSettingsEnv: envelope.pinned } : options.hostInference
      ? { pinnedSettingsEnv: inferenceEnv } : {}),
    finishWorker: envelope
      ? () => worker.finish().finally(() => envelope.relay.stop())
      : async () => {
        await worker.finish();
        if (owned) acknowledgeClaudeContext(backend.brainPath, contextId, owned, childEnv);
      },
    workerLimits: { current: worker.limits, settled: worker.settledLimits },
    workerFailure: worker.failure,
    workerStartFailure: worker.startFailure,
    workerStateRoom: worker.stateRoom,
    /** Each streamed piece of the answer, for the turn-temp purge's linked-file guard (#1703). */
    observeAnswerText: (text: string) => { answerText += text; },
    prompt: owned ? (async function* () {
      yield { ...userMessage(owned.text, req.attachments), uuid: owned.id as SDKUserMessage["uuid"] };
    })() :
      req.attachments && req.attachments.length > 0
        ? buildAttachmentPrompt(prompt, req.attachments)
        : prompt,
  };
}

/**
 * Options are a request, not evidence: managed CLI settings can clamp them.
 * Stop reports the main turn's active effort after that clamp. Preserve all
 * permission hooks and never let this observation decide tool permission.
 */
function observeEffectiveEffort(sdkOptions: Options, req: StartTurnRequest): void {
  sdkOptions.hooks = {
    ...sdkOptions.hooks,
    Stop: [...(sdkOptions.hooks?.Stop ?? []), { hooks: [async (input) => {
      const effective = input.effort?.level;
      if (isThinkingLevel(effective)) {
        req.bridge.emit({ type: "status", status: "thinking", sessionId: input.session_id,
          thinkingLevel: req.thinkingLevel, effectiveThinkingLevel: effective });
      }
      return {};
    }] }],
  };
}

/** Warn the agent, once its runtime state is nearly full, to continue in a new conversation. */
function addStateRoomWarning(sdkOptions: Options, req: StartTurnRequest, worker: ReturnType<typeof createWorkerSpawn>): void {
  sdkOptions.hooks = {
    ...sdkOptions.hooks,
    UserPromptSubmit: [...(sdkOptions.hooks?.UserPromptSubmit ?? []), { hooks: [async () => {
      const observation = worker.stateRoom();
      return observation && stateRoomWarning(observation) ? { hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: `${stateRoomCopy(observation)} Continue in a new conversation before it is full. This one stays available.`
          + (req.posture === "voice" ? " This is a visual host notice only: do not speak it or treat it as a spoken grant." : ""),
      } } : {};
    }] }],
  };
}

/** The in-process brain-ui MCP server, with the bridge handlers the roster bound. */
function turnMcpServer(
  backend: ClaudeBackendOptions,
  req: StartTurnRequest,
  roster: ClaudeToolRoster,
  turnTemp: TurnTempAccess,
  observeTools: (tools: unknown[]) => void
) {
  const { askUser, askUserList, askUserRank, askUserForm, getLocation, requestMask, proposePolicyChange, queryActivity, turnTempTool } = roster;
  return createBrainUiMcpServer({
    observeTools,
    stableRoster: !req.autonomous,
    proposePolicyChange,
    application: req.bridge,
    askUser,
    askUserList,
    askUserRank,
    askUserForm,
    askUserFormLimits: req.bridge.askUserFormLimits,
    getLocation,
    requestMask,
    queryActivity,
    ...(!req.autonomous || req.bridge.inboxList ? { inbox: req.bridge } : {}),
    ...(!req.autonomous || req.bridge.referenceAccess ? { reference: req.bridge } : {}),
    // Never in an autonomous roster: its membership is exact server authority.
    ...(!req.autonomous ? { compute: req.bridge } : {}),
    // Interactive sessions only: a restricted autonomous roster never lists Apify.
    ...(!req.autonomous ? { apify: req.bridge } : {}),
    // Every interactive session, with or without attachments, so a file never changes the roster.
    ...(!req.autonomous ? { attachments: req.bridge } : {}),
    ...(turnTempTool ? { turnTemp: createTurnTempTool(turnTemp, event => {
      try { req.bridge.activity?.(event); } catch { /* Observability must not fail the observed turn. */ }
    }) } : {}),
    brainPath: backend.brainPath,
  });
}

/** Once past 80% of the allowance and once when full, after the step that did it. */
function addTurnTempPressure(sdkOptions: Options, turnTemp: TurnTempAccess): void {
  const pressure = createTurnTempPressureHook(turnTemp);
  sdkOptions.hooks = {
    ...sdkOptions.hooks,
    PostToolUse: [...(sdkOptions.hooks?.PostToolUse ?? []), { hooks: [pressure] }],
    PostToolUseFailure: [...(sdkOptions.hooks?.PostToolUseFailure ?? []), { hooks: [pressure] }],
  };
}

/** Flag settings outrank every settings file; a restricted turn reads none from the brain. */
function applyTurnSettings(
  sdkOptions: Options,
  envelope: ReturnType<typeof claudeAutonomousEnvelope> | undefined,
  subscriptionOnly: boolean,
  inferenceEnv: Readonly<Record<string, string>> | undefined
): void {
  if (envelope) {
    // A restricted turn reads no settings, instructions, skills or hooks from
    // the brain: its instructions are the server's immutable snapshot (R29).
    sdkOptions.settingSources = [];
    // Flag settings outrank every settings file: none can reroute inference.
    sdkOptions.settings = { apiKeyHelper: "", env: { ...envelope.pinned } };
  } else if (subscriptionOnly || inferenceEnv) {
    // Flag settings outrank every settings file: none can reroute inference
    // or put a credential back in front of the relay's placeholder.
    sdkOptions.settings = { ...NEUTRALISED_SETTINGS, ...(inferenceEnv ? RELAYED_TURN_SETTINGS : {}), env: { ...NEUTRALISED_SETTINGS.env,
      ...(inferenceEnv ?? {}),
    } };
  }
  if (!envelope) {
    // A resumed preset must extend the same cached prefix even after Git
    // changes. This also removes the CLI's commit/PR guidance; a brain can
    // keep its own guidance in CLAUDE.md. Apply after both billing branches.
    sdkOptions.settings = { ...sdkOptions.settings as object, includeGitInstructions: false };
  }
}

/** The prompt-prefix fingerprint an interactive turn reports as activity. */
function reportPromptPrefix(req: StartTurnRequest, sdkOptions: Options, assembledTools: unknown[] | undefined): void {
  try { req.bridge.activity?.({ kind: "prompt_prefix", resumed: req.sessionId !== undefined,
    prefix: promptPrefixFingerprint({
      // These are SDK assembly inputs. CLI built-ins/project MCP schemas are
      // opaque here; this digest must never be called a complete wire roster.
      tools: assembledTools === undefined ? undefined : { builtinSelection: sdkOptions.tools ?? "runtime_default", disallowed: sdkOptions.disallowedTools, bridge: assembledTools },
      system: sdkOptions.systemPrompt, model: sdkOptions.model, thinking: sdkOptions.effort,
      gitStatusIncluded: false,
    }) }); } catch { /* Observability must not fail the observed turn. */ }
}

function buildAppend(
  options: ClaudeBackendOptions,
  client: ClientEnvironment | undefined,
  tools: {
    policyChange: boolean;
    askUser: boolean;
    askUserList: boolean;
    askUserRank: boolean;
    askUserForm: boolean;
    location: boolean;
    mask: boolean;
    activity: boolean;
    inbox: boolean;
    block: boolean;
    turnTemp: boolean;
    reference: boolean;
    compute: boolean;
  },
  turnBudgetMs: number | undefined
): string {
  // The interactive caller snapshots the fixed brief once. Live facts travel
  // only on the new user message; restricted envelopes keep their own policy.
  return (
    options.systemPromptAppend ??
    buildSystemPromptAppend({
      ...(client ? { client } : {}),
      ...(turnBudgetMs ? { turnBudgetMs } : {}),
      tools: {
        policyChange: tools.policyChange ? "mcp__brain-ui__propose_policy_change" : undefined,
        askUser: tools.askUser && ASK_USER_TOOL_NAME,
        askUserList: tools.askUserList && ASK_USER_LIST_TOOL_NAME,
        askUserRank: tools.askUserRank && ASK_USER_RANK_TOOL_NAME,
        askUserForm: tools.askUserForm && ASK_USER_FORM_TOOL_NAME,
        location: tools.location && GET_LOCATION_TOOL_NAME,
        mask: tools.mask && MASK_TOOL_NAME,
        activity: tools.activity && QUERY_ACTIVITY_TOOL_NAME,
        inboxList: tools.inbox && visibleToolName("inbox_list", "claude"),
        inboxGet: tools.inbox && visibleToolName("inbox_get", "claude"),
        inboxAdd: tools.inbox && visibleToolName("inbox_add", "claude"),
        resolveAction: tools.inbox && visibleToolName("resolve_action", "claude"),
        completeShare: tools.inbox && visibleToolName("complete_share", "claude"),
        block: tools.block && SHOW_BLOCK_TOOL_NAME,
        turnTemp: tools.turnTemp && TURN_TEMP_TOOL_NAME,
        referenceSource: tools.reference && visibleToolName("reference_source", "claude"),
        referenceWorktree: tools.reference && visibleToolName("reference_worktree", "claude"),
        ...Object.fromEntries(COMPUTE_SURFACE_KEYS.map(([key, name]) => [key, tools.compute && visibleToolName(name, "claude")])),
      },
    })
  );
}

/**
 * Fold a text prompt plus image attachments into the single streamed
 * SDKUserMessage the SDK accepts for multimodal turns.
 */
async function* buildAttachmentPrompt(
  text: string,
  attachments: ChatImageAttachment[]
): AsyncIterable<SDKUserMessage> {
  yield userMessage(text, attachments);
}

/**
 * The sandbox an ordinary turn prepares for itself when its host supplied
 * none (#2796), awaiting the scratch area's git check instead of blocking the
 * event loop while a loaded host starts its maintenance worker. Without a
 * relayed transport or the restricted envelope, `assembleClaudeSdkTurn`'s
 * `childEnv` is the turn's environment: it is resolved once here and returned,
 * so the turn's options are built from the same one. Undefined when the host
 * supplied a sandbox or the assembly prepares its own.
 */
export async function prepareClaudeTurnSandbox(options: Pick<ClaudeSdkTurnOptions, "backend" | "req" | "profile" | "turnEnvironment" | "hostInference">) {
  const { backend, req } = options;
  if (req.workerSandbox || options.hostInference || req.autonomous?.containment === "restricted") return undefined;
  const turnEnvironment = options.turnEnvironment ?? turnEnv(options.profile);
  return { turnEnvironment, workerSandbox: await prepareWorkerSandboxAsync(backend.brainPath, { maintenance: backend.maintenance }) };
}
