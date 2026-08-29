/**
 * Headless OAuth login service over pi's ModelRuntime, so a host UI (brain-ui
 * Settings) can drive provider sign-in — most importantly the OpenAI
 * "openai-codex" ChatGPT-subscription provider — without a TTY.
 *
 * pi's `ModelRuntime.login()` is the ONLY supported entry point (the
 * device-code primitives are module-private in pi-ai), and it is built for an
 * interactive client: it blocks until the whole flow settles (up to 15
 * minutes for device code) and surfaces the user code mid-await through the
 * `AuthInteraction.notify` callback. This service adapts that shape to a
 * request/poll API:
 *
 *   startLogin() answers the method prompt with "device_code", captures the
 *   `device_code` notify event into a flow record, and returns as soon as the
 *   code is known (or the login fails first). The login promise keeps running
 *   detached; getFlow() polls its state; cancelFlow() aborts via the
 *   interaction signal. Credential persistence is entirely pi's:
 *   ModelRuntime.login writes ~/.pi/agent/auth.json (PI_CODING_AGENT_DIR
 *   aware) through its own locked store — the same file the chat sessions
 *   read, so a login here is immediately visible to the agent backend.
 *
 * The exported surface is deliberately primitives-only (strings/numbers) so
 * the host can type it as a structural mirror without importing pi packages.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { BackendLogFn } from "./backend.js";

export interface PiAuthProviderStatus {
  providerId: string;
  /** Human label for the credential, e.g. "OpenAI (ChatGPT Plus/Pro)". */
  name: string;
  /** Whether pi currently resolves usable auth for this provider. */
  configured: boolean;
  /** Where the credential comes from when configured ("stored", "environment", …). */
  source?: string;
  /** True when the provider supports OAuth login through this service. */
  oauth: boolean;
}

export type PiLoginFlowStatus = "pending" | "success" | "error" | "cancelled";

export interface PiLoginFlow {
  id: string;
  providerId: string;
  status: PiLoginFlowStatus;
  /** Device-flow user code, once the provider issued one. */
  userCode?: string;
  /** Where the user enters the code (e.g. https://auth.openai.com/codex/device). */
  verificationUri?: string;
  /** Suggested client poll interval. */
  intervalSeconds?: number;
  /** Device-code validity window. */
  expiresInSeconds?: number;
  error?: string;
  startedAt: number;
}

export interface PiAuth {
  /** Auth status for the given pi provider ids. */
  status(providerIds: string[]): Promise<PiAuthProviderStatus[]>;
  /**
   * Start an OAuth device-code login. Resolves once the user code is known
   * (or the flow already failed) — never blocks for the whole flow. A new
   * start for a provider cancels that provider's previous pending flow.
   */
  startLogin(providerId: string): Promise<PiLoginFlow>;
  /** Snapshot of one flow, or null when unknown/expired. */
  getFlow(id: string): PiLoginFlow | null;
  /** Abort a pending flow. No-op for settled/unknown flows. */
  cancelFlow(id: string): void;
  /** Remove the stored credential for a provider. */
  logout(providerId: string): Promise<void>;
}

/**
 * The slice of ModelRuntime this service drives — injectable for tests.
 * Matches the real class structurally.
 */
export interface PiAuthRuntime {
  login(
    providerId: string,
    type: "oauth",
    interaction: {
      signal?: AbortSignal;
      prompt(prompt: AuthPrompt): Promise<string>;
      notify(event: AuthEvent): void;
    }
  ): Promise<unknown>;
  logout(providerId: string): Promise<void>;
  getProviderAuthStatus(providerId: string): {
    configured: boolean;
    source?: string;
  };
  getProvider(providerId: string):
    | { auth?: { oauth?: { name?: string } } }
    | undefined;
}

export interface CreatePiAuthOptions {
  log?: BackendLogFn;
  /** Test seam — defaults to a lazily created real ModelRuntime. */
  runtime?: () => Promise<PiAuthRuntime>;
}

/** Settled flows are kept for polling this long, then dropped. */
const FLOW_RETENTION_MS = 30 * 60 * 1000;

/**
 * Providers whose pi OAuth flow this service can actually drive headlessly —
 * i.e. whose only interactive step is the method selector it answers with
 * "device_code". Other providers' flows open with prompts (pasted codes,
 * text input) the web surface does not support yet, so they must not be
 * advertised as connectable.
 */
const WEB_LOGIN_PROVIDERS = new Set(["openai-codex"]);

export function createPiAuth(options: CreatePiAuthOptions = {}): PiAuth {
  let runtimePromise: Promise<PiAuthRuntime> | null = null;
  function getRuntime(): Promise<PiAuthRuntime> {
    if (!runtimePromise) {
      runtimePromise =
        options.runtime?.() ??
        (ModelRuntime.create() as Promise<unknown> as Promise<PiAuthRuntime>);
      // A failed create must not poison every later call.
      runtimePromise.catch(() => {
        runtimePromise = null;
      });
    }
    return runtimePromise;
  }

  interface FlowState {
    flow: PiLoginFlow;
    controller: AbortController;
    settledAt?: number;
  }
  const flows = new Map<string, FlowState>();
  const pendingByProvider = new Map<string, string>();

  function prune(): void {
    const now = Date.now();
    for (const [id, state] of flows) {
      if (state.settledAt && now - state.settledAt > FLOW_RETENTION_MS) {
        flows.delete(id);
      }
    }
  }

  function settle(state: FlowState, status: PiLoginFlowStatus, error?: string): void {
    if (state.flow.status !== "pending") return;
    state.flow.status = status;
    if (error) state.flow.error = error;
    state.settledAt = Date.now();
    if (pendingByProvider.get(state.flow.providerId) === state.flow.id) {
      pendingByProvider.delete(state.flow.providerId);
    }
  }

  return {
    async status(providerIds) {
      const runtime = await getRuntime();
      return providerIds.map((providerId) => {
        const status = runtime.getProviderAuthStatus(providerId);
        const oauth = runtime.getProvider(providerId)?.auth?.oauth;
        return {
          providerId,
          name: oauth?.name ?? providerId,
          configured: status.configured,
          ...(status.source ? { source: status.source } : {}),
          oauth: Boolean(oauth) && WEB_LOGIN_PROVIDERS.has(providerId),
        };
      });
    },

    async startLogin(providerId) {
      prune();
      if (!WEB_LOGIN_PROVIDERS.has(providerId)) {
        throw new Error(
          `Provider "${providerId}" cannot be signed in from the web UI. ` +
            "Use `pi login` on the host instead."
        );
      }
      // Resolve the runtime BEFORE claiming the provider slot: with an await
      // between check and claim, two simultaneous starts would both see no
      // pending flow and run two device flows at once.
      const runtime = await getRuntime();
      // One pending flow per provider: a re-click supersedes, never stacks.
      const previous = pendingByProvider.get(providerId);
      if (previous) this.cancelFlow(previous);

      const controller = new AbortController();
      const state: FlowState = {
        flow: {
          id: crypto.randomUUID(),
          providerId,
          status: "pending",
          startedAt: Date.now(),
        },
        controller,
      };
      flows.set(state.flow.id, state);
      pendingByProvider.set(providerId, state.flow.id);

      let codeReady!: () => void;
      const codeKnown = new Promise<void>((resolve) => {
        codeReady = resolve;
      });

      const login = runtime
        .login(providerId, "oauth", {
          signal: controller.signal,
          prompt: (prompt) => {
            // The only expected prompt is the method selector; answer it with
            // the device flow (the browser flow binds a localhost callback
            // port on the SERVER, which is wrong for a remote deployment).
            if (
              prompt.type === "select" &&
              prompt.options.some((option) => option.id === "device_code")
            ) {
              return Promise.resolve("device_code");
            }
            return Promise.reject(
              new Error(
                `This provider's login needs an interactive "${prompt.type}" prompt, ` +
                  "which the web flow cannot answer. Use `pi login` on the host instead."
              )
            );
          },
          notify: (event) => {
            if (event.type === "device_code") {
              state.flow.userCode = event.userCode;
              state.flow.verificationUri = event.verificationUri;
              if (event.intervalSeconds !== undefined) {
                state.flow.intervalSeconds = event.intervalSeconds;
              }
              if (event.expiresInSeconds !== undefined) {
                state.flow.expiresInSeconds = event.expiresInSeconds;
              }
              codeReady();
            }
          },
        })
        .then(() => {
          if (state.flow.status === "cancelled") {
            // The user approved at the provider in the same instant they hit
            // Cancel here: the credential is already persisted, but the UI
            // told them the login was cancelled. Honor the cancel — unless a
            // NEWER flow for this provider is underway, whose credential this
            // logout would destroy.
            if (!pendingByProvider.has(providerId)) {
              runtime.logout(providerId).catch(() => {});
              options.log?.("info", "pi oauth login cancelled after approval; credential removed", {
                providerId,
              });
            }
            return;
          }
          settle(state, "success");
          options.log?.("info", "pi oauth login completed", { providerId });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (controller.signal.aborted) {
            settle(state, "cancelled");
          } else {
            settle(state, "error", message);
            options.log?.("warn", "pi oauth login failed", { providerId, error: message });
          }
        });
      // The flow outlives this request on purpose; nothing awaits `login`
      // beyond the race below, and its rejections are handled above.
      void login;

      // Return as soon as the code exists (or the flow already settled —
      // e.g. an immediate network failure).
      await Promise.race([codeKnown, login]);
      return { ...state.flow };
    },

    getFlow(id) {
      prune();
      const state = flows.get(id);
      return state ? { ...state.flow } : null;
    },

    cancelFlow(id) {
      const state = flows.get(id);
      if (!state || state.flow.status !== "pending") return;
      state.controller.abort();
      settle(state, "cancelled");
    },

    async logout(providerId) {
      const pending = pendingByProvider.get(providerId);
      if (pending) this.cancelFlow(pending);
      const runtime = await getRuntime();
      await runtime.logout(providerId);
    },
  };
}
