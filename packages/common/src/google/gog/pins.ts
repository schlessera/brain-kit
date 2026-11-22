/**
 * The gog releases the transport accepts (plan §8, "An exact pin"; ruling 2):
 * each version with its release commit and the sha256 of its release binary
 * per platform.
 *
 * A hash is of the `gog` binary inside the release tarball, after verifying
 * the tarball against the release's `checksums.txt`. Package-manager builds
 * do not match and are refused. Adding a version is an upgrade: regenerate
 * the schema snapshot from the new binary, run the live shape check
 * (`scripts/google-shape-check.ts`) and the disposable-account write proof,
 * then add its row here.
 */

/** Platforms gog publishes release binaries for that the transport knows. */
export const GOG_PLATFORMS = ["linux_amd64", "linux_arm64", "darwin_amd64", "darwin_arm64"] as const;
export type GogPlatform = typeof GOG_PLATFORMS[number];

export interface GogPin {
  /** The version without its `v`, as `gog version` prints it after the `v`. */
  version: string;
  /** The short release commit `gog version` prints. */
  commit: string;
  /** sha256 of the release binary, lower-case hex, per platform. */
  sha256: Readonly<Partial<Record<GogPlatform, string>>>;
}

export const GOG_PINS: readonly GogPin[] = Object.freeze([
  Object.freeze({
    version: "0.48.1",
    commit: "44364d31",
    sha256: Object.freeze({
      linux_amd64: "c943659544d425aee0c21b46b8f4c7939a4db2f12d5928dcf99f83ddecfb255f",
      linux_arm64: "520cbe587cea302d3e7770c43704856d8582ad888de344c8d1f7812997020a9c",
      darwin_amd64: "11e628e9aa4825fb1719da2d9f8874e6c86ce3f518cb719db702fdfb1879dc1b",
      darwin_arm64: "022abce88d0b32cc27ff17a893abf34dca8bf3ad8b8181164d7d2b2b1a68e7c1",
    }),
  }),
]);

const ARCH: Readonly<Record<string, string>> = { x64: "amd64", arm64: "arm64" };

/** The pin platform of a Node platform and architecture, or null when gog's release names none the transport knows. */
export function gogPlatform(platform: string, arch: string): GogPlatform | null {
  const key = `${platform}_${ARCH[arch] ?? arch}`;
  return (GOG_PLATFORMS as readonly string[]).includes(key) ? key as GogPlatform : null;
}
