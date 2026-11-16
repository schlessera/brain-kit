/**
 * What the #3434 extraction classifier sees, and how the authored cases are
 * shaped. Nothing here is product code: the spike measures whether a
 * classifier of this shape is worth building in the admission path.
 */

/** Where the call was admitted, which decides what can be read from it. */
export type Surface = "web_fetch" | "bash" | "mcp" | "brain_cli" | "provider_relay";

/**
 * The host's existing classification of the call, before this classifier:
 * the command policy's read/outward split (`prepareOutwardPlan`,
 * `packages/ui-sdk/src/server/outward-policy.ts:45`). `opaque` is a call
 * the host cannot read, such as a script file.
 */
export type ToolClass = "read" | "outward" | "opaque";

/** One authored outgoing call, as the admission point receives it. */
export interface CallInput {
  id: string;
  surface: Surface;
  /** Tool name as admitted: `WebFetch`, `Bash`, `mcp__<server>__<tool>`, `brain`. */
  tool: string;
  toolClass: ToolClass;
  /** WebFetch: the URL. */
  url?: string;
  /** WebFetch: the prompt. It goes to the fetch summarizer, never to the destination. */
  prompt?: string;
  /** Bash and `brain` CLI: the full command line. */
  command?: string;
  /** MCP and provider relay: the arguments or request body. */
  args?: Record<string, unknown>;
  /** Provider relay only: the configured provider host. */
  relayHost?: string;
}

export type Gold = "benign" | "extraction";
export type Band = "allow" | "ask" | "block";

export interface AuthoredCall extends CallInput {
  gold: Gold;
  /** What a careful reviewer who saw the request and the session's reads would choose. */
  goldBand: Band;
  /** Case family, for the per-family table. */
  family: string;
  /** The heuristic this case was written to evade, when it is adversarial. */
  evades?: string;
  note: string;
}

/** What tainted the session. Only `name` and the hosts reach the classifier. */
export interface TaintSource {
  kind: "web_fetch" | "web_search" | "share" | "workspace" | "mcp" | "user_marked";
  /** A display name, like the permission card shows: `WebFetch harbour-notices.example`. */
  name: string;
  /**
   * Hosts named in the tainting content, extracted host-side when the content
   * is ingested. The content itself never reaches the classifier.
   */
  hosts: string[];
}

export interface Session {
  id: string;
  split: "tuning" | "held-out";
  /** True for the realistic benign session whose ask rate the issue asks for. */
  realistic?: boolean;
  taint: TaintSource;
  /** Corpus-relative brain files read earlier in the session (fixture corpus). */
  reads: string[];
  /** Hosts the session's proxies admitted before the taint, so already contacted. */
  contacted: string[];
  calls: AuthoredCall[];
}

export interface CaseFile {
  issue: number;
  day: string;
  corpus: string;
  sessions: Session[];
}

/**
 * The normalized request the classifier scores: the schema the deliverable
 * names. Built host-side from a `CallInput` by `toRequest`.
 */
export interface OutgoingRequest {
  surface: Surface;
  tool: string;
  toolClass: ToolClass;
  /**
   * `network` reaches a destination through the turn proxy; `relay` is a
   * validated provider-relay request, routed under G2; `local` opens no
   * connection (brain-kit's own MCP servers, local `brain` commands).
   */
  route: "network" | "relay" | "local";
  method: string;
  /** Destination hosts, lowercased. Empty for `local`. */
  hosts: string[];
  /** Path, query and subdomain labels of each URL, raw. */
  urls: Array<{ host: string; path: string; query: string }>;
  /** Everything else that reaches the destination: body, command arguments, MCP argument values. */
  body: string;
  /** Brain-relative paths the call names, which a command can send without quoting their text. */
  pathRefs: string[];
  bytes: { query: number; body: number };
}
