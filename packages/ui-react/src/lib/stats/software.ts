import packageInfo from "@schlessera/brain-ui-react/package.json" with { type: "json" };
import type { Fetched } from "./compose-stats.js";

/** The release resolved by the client bundler, independent of the server. */
export const CLIENT_RELEASE = packageInfo.version;
export interface SoftwareIdentity { release: string | null; sourceCommit: string | null }
export interface SoftwareInput {
  client: SoftwareIdentity;
  server: Fetched<SoftwareIdentity>;
}

/** Missing and development markers are not verifiable identities. */
function known(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !/^(dev|development|unknown)$/i.test(value.trim())
    ? value.trim() : null;
}

export function softwareDetails({ client, server }: SoftwareInput) {
  const c = { release: known(client.release), sourceCommit: known(client.sourceCommit) };
  const s = server.ok
    ? { release: known(server.value.release), sourceCommit: known(server.value.sourceCommit) }
    : { release: null, sourceCommit: null };
  const releaseDiffers = c.release && s.release && c.release !== s.release;
  const buildDiffers = c.sourceCommit && s.sourceCommit && c.sourceCommit !== s.sourceCommit;
  const complete = c.release && s.release && c.sourceCommit && s.sourceCommit;
  const differs = Boolean(releaseDiffers || buildDiffers);
  return {
    client: c, server: s,
    tone: differs ? "gold" as const : complete ? "teal" as const : "neutral" as const,
    state: differs ? "Client and server differ" : complete ? "Release and build match" : "Build match unverified",
    detail: !server.ok ? `Server unavailable: ${server.error}.`
      : differs ? "The loaded client and server report different identities. This does not establish protocol incompatibility. Reload to load the current client."
      : complete ? "Both report the same package release and application revision."
      : "Missing or development metadata cannot verify a build match.",
  };
}
