import { geoConfigSchema, type GeoConfig } from "@schlessera/brain-geo";
import { brainConfigSchema, type BrainConfig } from "./config.js";
import { safeResolve } from "./safe-path.js";

/** Resolve canonical geo settings without making the disposable cache authoritative. */
export function resolveGeoConfig(root: string, config: BrainConfig | null): GeoConfig {
  const geo = geoConfigSchema.parse(brainConfigSchema.parse(config ?? {}).geo ?? {});
  if (geo.cacheDir !== undefined) {
    const cacheDir = safeResolve(root, geo.cacheDir);
    if (cacheDir === null) throw new Error("geo.cacheDir must remain inside the brain root, including through symlinks.");
    geo.cacheDir = cacheDir;
  }
  // The library's global admission remains independent of this response-cache path.
  return geo;
}
