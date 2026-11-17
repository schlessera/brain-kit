/**
 * Image host allowlist entries (#2496). The renderer turns each entry into one
 * `EXCLUDE <host>` in Chrome's DNS blackhole (`--host-resolver-rules`), whose
 * syntax is a comma-separated rule list with wildcard host patterns. So an
 * entry must be a plain DNS host name or IP literal, nothing else: `*` would
 * exempt every host, and a comma would inject another rule.
 */

/** Lowercase labels of letters, digits, `-` and `_`, dot-separated; or a bracketed IPv6 literal. */
const PLAIN_HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;

/** Why `value` is not a plain host, or `null` when it is one. */
export function allowHostProblem(value: string): string | null {
  const lower = value.toLowerCase();
  let parsed: string | null = null;
  try {
    parsed = new URL(`http://${lower}`).hostname;
  } catch {
    parsed = null;
  }
  // The URL parser keeps `*` and `,` in a host name, so the pattern carries
  // the refusal; the round trip catches what the parser would rewrite.
  if (PLAIN_HOST.test(lower) && parsed === lower) return null;
  return `"${value}" is not a plain host name or IP address (no wildcard, comma, space, scheme, port or path)`;
}

/** The entries lowercased, or a throw naming the first that is not a plain host. */
export function normalizeAllowHosts(values: readonly string[]): string[] {
  return values.map((value) => {
    const problem = allowHostProblem(value);
    if (problem) throw new Error(problem);
    return value.toLowerCase();
  });
}
