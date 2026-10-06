import {
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { buildSystemPromptAppend, type WebSearchBrief } from "@schlessera/brain-ui-sdk/server";
import { resolveWebSearchConfigPath, webSearchBrief } from "@schlessera/brain-ui-sdk/internal";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type {
  CreatePiBackendOptions,
  SessionCaps,
  SessionEnv,
  SessionToolkit,
} from "./backend-options.js";
import type { BrainAccess } from "./brain-access.js";
import { resolveWebSearchEnv } from "./config/env.js";
import { createPermissionGate } from "./permission-gate.js";
import { createTurnContext } from "./turn-context.js";
import {
  createBrainTools,
  PI_ASK_USER_TOOL_NAME,
  type ToolLock,
} from "./tools.js";

export function createSessionResources(options: {
  backend: CreatePiBackendOptions;
  brain: BrainAccess;
  lock: ToolLock;
  allowedTools: ReadonlySet<string>;
  confirmPatterns: readonly RegExp[];
  loadExtensions: boolean;
}) {
  const { backend, brain, lock, allowedTools, confirmPatterns, loadExtensions } = options;
  const brainPath = backend.brainPath;

  /** A fresh per-session TurnContext and the curated tools bound to it. */
  function buildToolkit(caps: SessionCaps): SessionToolkit {
    const turnContext = createTurnContext();
    const tools = createBrainTools({
      brain,
      turn: turnContext,
      lock,
      capabilities: {
        location: caps.location,
        activity: caps.activity,
        mask: caps.mask,
      },
    });
    return { tools, turnContext };
  }

  /**
   * Per-SESSION resource loader: skills, context files, extensions AND the
   * permission gate (an inline extension closing over this session's turn
   * holder). Built per session — not shared — because the gate must reach this
   * session's live bridge and the system-prompt append carries this session's
   * client environment.
   *
   * A loader failure is FATAL for the session, not a degrade-and-continue:
   * without the loader there is no permission gate, and running extension or
   * curated mutating tools ungated is worse than failing the turn loudly.
   */
  async function build(
    toolkit: SessionToolkit,
    env: SessionEnv
  ): Promise<{ loader: DefaultResourceLoader; settingsManager: SettingsManager }> {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(brainPath, agentDir);
    const subagentTool =
      loadExtensions && hasPackage(settingsManager, "pi-subagents") ? "subagent" : false;
    // No web extension, no search tool — and nothing to say about providers.
    const webSearch =
      loadExtensions && hasPackage(settingsManager, "pi-web-access")
        ? readWebSearchBrief()
        : undefined;
    const append = env.autonomous?.systemPromptAppend ?? buildAppend(backend, env, subagentTool, webSearch);
    const loader = new DefaultResourceLoader({
      cwd: brainPath,
      agentDir,
      settingsManager,
      noExtensions: !loadExtensions,
      extensionFactories: [
        createPermissionGate({ turn: toolkit.turnContext,
          allowedTools: env.autonomous ? new Set(env.autonomous.allowedTools) : allowedTools, confirmPatterns }),
      ],
      agentsFilesOverride: withCwdContextFiles,
      ...(append
        ? { appendSystemPromptOverride: (base: string[]) => [...base, append] }
        : {}),
    });
    await loader.reload();
    return { loader, settingsManager };
  }

  /**
   * Ensure BOTH cwd context files load. pi's own discovery takes the FIRST of
   * AGENTS.md / CLAUDE.md per directory, but the Claude backend reads
   * CLAUDE.md — a brain repo carrying both (AGENTS.md as a managed skills
   * index, CLAUDE.md as the instructions) would give the two backends
   * different context. Loading both keeps the backends aligned; duplicates
   * are filtered by path.
   */
  function withCwdContextFiles(base: {
    agentsFiles: Array<{ path: string; content: string }>;
  }): { agentsFiles: Array<{ path: string; content: string }> } {
    const files = [...base.agentsFiles];
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(brainPath, name);
      if (files.some((f) => f.path === path) || !existsSync(path)) continue;
      try {
        files.push({ path, content: readFileSync(path, "utf-8") });
      } catch (err) {
        backend.log?.("warn", "failed to read context file", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { agentsFiles: files };
  }

  return { buildToolkit, build };
}

function buildAppend(
  options: CreatePiBackendOptions,
  env: SessionEnv,
  subagentTool: string | false,
  webSearch: WebSearchBrief | undefined
): string {
  // The chat-surface brief for one session: what the answer renders into
  // (diagrams, share blocks), which bridge tools exist, the reader's device.
  // Unlike the Claude backend (whose subprocess is rebuilt every turn) this is
  // baked at SESSION construction, from the session-opening turn's client — a
  // later device change applies from the next new/reopened session.
  return (
    options.systemPromptAppend ??
    buildSystemPromptAppend({
      ...(env.client ? { client: env.client } : {}),
      ...(env.turnBudgetMs ? { turnBudgetMs: env.turnBudgetMs } : {}),
      // Which search providers this deployment actually reaches. Omitted when
      // the web extension is absent — there is no search tool then.
      ...(webSearch ? { webSearch } : {}),
      // Named only when the bridge actually provides the handler — the toolkit
      // registers each tool on the same condition.
      tools: {
        askUser: env.caps.askUser && PI_ASK_USER_TOOL_NAME,
        askUserList: env.caps.askUserList && "ask_user_list",
        askUserRank: env.caps.askUserRank && "ask_user_rank",
        askUserForm: env.caps.askUserForm && "ask_user_form",
        location: env.caps.location && "get_current_location",
        activity: env.caps.activity && "query_activity",
        mask: env.caps.mask && "request_image_mask",
        // Always registered: it needs nothing from the bridge.
        block: "show_block",
      },
      // How THIS backend executes: sessions persist in-process (no per-turn
      // subprocess), sibling tool calls run concurrently, and the fan-out tool
      // exists only when the pi-subagents package is installed — naming a
      // missing tool would send the model after it.
      execution: {
        perTurnProcess: false,
        parallelToolCalls: true,
        subagentTool,
      },
    })
  );
}

/**
 * Whether the pi-subagents package is installed (global or project scope),
 * read from the same settings the extension loader consults. Presence in the
 * package list is the honest signal available at session build; a package that
 * is installed but fails to load simply leaves the model with a named tool
 * that errors — the same failure mode any extension has.
 */
function hasPackage(settingsManager: SettingsManager, name: string): boolean {
  try {
    const settings = settingsManager.getGlobalSettings() as {
      packages?: Array<string | { source?: string }>;
    };
    const sources = (settings.packages ?? []).map((p) =>
      typeof p === "string" ? p : (p.source ?? "")
    );
    return sources.some((src) => src.includes(name));
  } catch {
    return false;
  }
}

/**
 * The web-search brief for this session, read from the same `web-search.json`
 * the pi-web-access extension reads.
 *
 * Resolved through the SDK helper, NOT from `agentDir`: pi puts its agent dir
 * at `~/.pi/agent` while the extension reads `~/.pi/web-search.json`, one level
 * up. Reading the wrong one finds nothing and would silently tell the model no
 * providers are configured.
 *
 * The extension lets its tool be renamed (`toolNames.webSearch`), so the brief
 * names whatever the model will actually see.
 */
function readWebSearchBrief(): WebSearchBrief | undefined {
  try {
    const env = resolveWebSearchEnv();
    const path = resolveWebSearchConfigPath(env);
    const raw = existsSync(path) ? readFileSync(path, "utf-8") : "{}";
    const parsed = JSON.parse(raw) as unknown;
    const config =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const names = config.toolNames;
    const named =
      names && typeof names === "object" && !Array.isArray(names)
        ? (names as Record<string, unknown>).webSearch
        : undefined;
    const toolName =
      typeof named === "string" && named.trim() ? named.trim() : "web_search";
    return webSearchBrief(config, { toolName, env });
  } catch {
    // A malformed config is the extension's problem to report; the brief just
    // stays silent rather than claiming a provider set it cannot read.
    return undefined;
  }
}
