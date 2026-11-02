/** A relayed Claude turn's pins against the runtime's own connections (#3244). */
/**
 * What a turn on the turn proxy pins so the Claude runtime opens no
 * connection of its own (#3244). Without it, the CLI's first-party event
 * logging and feature-flag fetches go to its vendor as plain worker
 * connections. The first of them taints the session (G6) before any tool
 * runs, and every later new host is refused. Inference already goes through
 * the relay, and a tool's own connections are unchanged.
 */
export const RELAYED_TURN_TRAFFIC_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});
/**
 * WebFetch checks each domain with its vendor before fetching, as a worker
 * connection of its own. On the turn proxy that check would taint the session
 * just before the fetch, so the host's egress policy is the only check (#3244).
 */
export const RELAYED_TURN_SETTINGS: Readonly<{ skipWebFetchPreflight: true }> = Object.freeze({ skipWebFetchPreflight: true });

/**
 * Whether the operator configured telemetry or opted out of it in a launch
 * environment, so the host adds no observability listener of its own. On a
 * relayed turn, `operator` is the environment before the host's pins: the
 * traffic opt-out the host pinned there is not the operator's (#3244).
 */
export function telemetryConfigured(launch: Readonly<Record<string, string | undefined>>,
  operator?: Readonly<Record<string, string | undefined>>): boolean {
  return Object.entries(launch).some(([key, value]) => value && (key.startsWith("OTEL_") || key.includes("TELEMETRY")
    || key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" && (!operator || Boolean(operator[key]))));
}
