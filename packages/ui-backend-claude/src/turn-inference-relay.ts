import { existsSync, linkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { ANTHROPIC_INFERENCE_ROUTES, startInferenceRelay, type InferenceRelay } from "@schlessera/brain-ui-sdk/internal";

import { apiKeyRelayCredential, type ApiKeyRelayCredential } from "./api-key-relay.js";
import { resolveEnv } from "./config/env.js";
import { authorizeDestination, resolveClaudeHostOAuth } from "./host-oauth.js";
import type { retainNativeRouteInputs } from "./native-route-inputs.js";
import type { InferenceProfile } from "./profiles.js";
import { selectedInferenceUpstream } from "./sdk-options.js";
import { settingsRefusal, type CliSettingsReport } from "./subscription.js";

/** The host's stored Claude login: masked in a relayed worker, or refused when the brain itself holds it. */
export function hostLoginFile(configDirectory: string, brainPath: string): { mask: string[]; inBrain: boolean } {
  const file = join(configDirectory, ".credentials.json");
  if (!existsSync(file)) return { mask: [], inBrain: false };
  const real = realpathSync(file), brain = realpathSync(brainPath);
  return real === brain || real.startsWith(`${brain}/`) ? { mask: [], inBrain: true } : { mask: [real], inBrain: false };
}

/** The same endpoint: canonical origin and base path, nothing else. */
export function sameRoute(value: unknown, selected: string): boolean {
  try {
    const url = new URL(String(value)), expected = new URL(selected);
    return typeof value === "string" && url.origin === expected.origin && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.replace(/\/+$/, "") === expected.pathname.replace(/\/+$/, "");
  } catch { return false; }
}

type Environment = Record<string, string | undefined>;

/**
 * The host inference relay of one interactive turn whose host prepared its
 * egress: the relay holds the credential, the worker reaches it through a
 * socket in its egress directory, and no credential leaves the relay until
 * the prompt gate has qualified the CLI's native settings.
 */
export class TurnInferenceRelay {
  /** The host-prepared egress; without it the turn runs no relay. */
  readonly egress: NonNullable<StartTurnRequest["workerSandbox"]>["egress"] | undefined;
  /** An API-billed profile's own key: declared by the host together with its route. */
  readonly apiCredential: ApiKeyRelayCredential | undefined;
  readonly hostLogin: { mask: string[]; inBrain: boolean } | undefined;
  readonly selectedUpstream: string;
  /** The worker's base URL: the relay's socket, at the selected route's path. */
  baseUrl = "http://localhost";
  routeInputs: Awaited<ReturnType<typeof retainNativeRouteInputs>> | undefined;
  #relay: InferenceRelay | undefined;
  #link: string | undefined;
  #authorized = false;
  readonly #configDirectory: string;
  readonly #turnEnvironment: Environment | undefined;
  readonly #authorizedOrigins: ReturnType<typeof resolveEnv>["claudeOAuthOrigins"];
  readonly #recipient: NonNullable<StartTurnRequest["workerSandbox"]>["inferenceRecipient"] | undefined;

  /** Selects the route and credential; starts nothing (see `start`). */
  constructor(inputs: { req: StartTurnRequest; profile: InferenceProfile; turnEnvironment: Environment | undefined; brainPath: string }) {
    const { req, profile, turnEnvironment } = inputs;
    this.#turnEnvironment = turnEnvironment;
    this.egress = !req.autonomous ? req.workerSandbox?.egress : undefined;
    // Only what the profile itself declares: an ambient credential never rides along.
    this.apiCredential = this.egress && profile.billing === "api" ? apiKeyRelayCredential(profile.id, profile.buildEnv()) : undefined;
    this.#configDirectory = resolve(turnEnvironment?.CLAUDE_CONFIG_DIR || join(turnEnvironment?.HOME || homedir(), ".claude"));
    this.hostLogin = this.egress ? hostLoginFile(this.#configDirectory, inputs.brainPath) : undefined;
    // The server selects the route: the profile's baseUrl, else the host's
    // ANTHROPIC_BASE_URL. Only the host's explicit list authorizes a custom
    // origin to receive the login (docs/decisions/claude-code-runtime.md).
    this.selectedUpstream = selectedInferenceUpstream(turnEnvironment);
    // Provider folders admitted for a proven recipient (#2695): only its relay may carry this turn.
    this.#recipient = !req.autonomous ? req.workerSandbox?.inferenceRecipient : undefined;
    if (this.#recipient && !this.egress) throw new BackendRequestError("This turn's provider folders were admitted for a recipient, but it has no inference relay to hold it to.");
    this.#authorizedOrigins = resolveEnv().claudeOAuthOrigins;
  }

  /**
   * Start the relay and link its socket into the egress directory. Each
   * handle is owned as soon as it exists, so `stop` and `unlink` release a
   * relay whose start failed part way.
   */
  start(): void {
    const egress = this.egress;
    if (!egress) return;
    this.#relay = startInferenceRelay({ upstream: this.selectedUpstream, routes: ANTHROPIC_INFERENCE_ROUTES, egress,
      ...(this.#recipient ? { recipientOrigin: this.#recipient.origin } : {}),
      credentials: async (signal, target) => {
        if (!this.#authorized) throw new Error("Native inference has not passed its prompt gate");
        this.routeInputs?.assertUnchanged();
        if (this.apiCredential) return this.apiCredential.headers;
        return { authorization: (await resolveClaudeHostOAuth(this.#configDirectory, this.#turnEnvironment ?? {},
          { origin: target.origin, authorizedOrigins: this.#authorizedOrigins }, signal)).authorization };
      },
    });
    this.baseUrl = `http://localhost${new URL(this.selectedUpstream).pathname.replace(/\/+$/, "")}`;
    this.#link = join(egress.dir, "inference.sock");
    linkSync(this.#relay.socketPath, this.#link);
  }

  /**
   * Qualify the CLI's native settings for this prepared transport. The
   * server's route must be authorized for the host login, and native
   * settings may repeat that route but never replace it. Returns why the
   * transport is refused, or undefined once the relay may hand out its
   * credential.
   */
  qualify(settings: CliSettingsReport | undefined, subscriptionOnly: boolean,
    pinnedSettingsEnv: Readonly<Record<string, string>> | undefined): string | undefined {
    try { this.routeInputs?.assertUnchanged(); }
    catch { return "native inference settings changed during startup"; }
    if (!Array.isArray(settings?.sources) || settings.sources.some(source => !["projectSettings", "flagSettings", "policySettings"].includes(source.source ?? ""))) {
      return "the native inference settings sources are not qualified for this prepared transport";
    }
    if (this.hostLogin?.inBrain) return "the host's Claude login is inside the brain, where the worker can read it; move the Claude config directory out of the brain";
    // A settings credential or helper would stand in for the relay's placeholder.
    const credentialConflict = subscriptionOnly ? null : settingsRefusal(settings, pinnedSettingsEnv);
    if (credentialConflict) return credentialConflict;
    try { if (!this.apiCredential) authorizeDestination({ origin: new URL(this.selectedUpstream).origin, authorizedOrigins: this.#authorizedOrigins }); }
    catch { return "the selected inference origin is not authorized to receive the host Claude login; list its exact origin in BRAIN_UI_CLAUDE_OAUTH_ORIGINS"; }
    for (const source of settings?.sources ?? []) {
      const value = source.settings?.env?.ANTHROPIC_BASE_URL;
      // Native settings may repeat the server's route, never replace it.
      if (value !== undefined && value !== "" && !(source.source === "flagSettings" && value === this.baseUrl) && !sameRoute(value, this.selectedUpstream)) {
        return "the native inference source selects a destination not qualified for this prepared transport";
      }
    }
    if (settings?.effective?.env?.ANTHROPIC_BASE_URL !== this.baseUrl) {
      return "native settings refused the prepared inference transport";
    }
    this.#authorized = true;
    return undefined;
  }

  stop(): unknown {
    return this.#relay?.stop();
  }

  unlink(): void {
    if (this.#link) rmSync(this.#link, { force: true });
  }
}
