/**
 * Invalidate pi's process-wide extension module cache.
 *
 * Why this exists: extension modules (pi-web-access and friends) cache their
 * config file at module scope, and pi's loader caches the loaded module per
 * path for the life of the process (same cwd). A configuration change written
 * from the Settings UI (`web-search.json`) would therefore only apply after a
 * server restart. Clearing the cache makes every NEW session re-import its
 * extensions, which re-read their config; already-resident sessions keep the
 * modules they loaded.
 *
 * `clearExtensionCache` is a pi internal (not in the package's exports map),
 * so it is reached by resolving the package entry and importing the loader
 * module by file URL — same resolved path, same module instance. Version
 * drift is tolerated: any failure returns false and the caller degrades to
 * "takes effect after a restart".
 */
export async function invalidateExtensionCache(): Promise<boolean> {
  try {
    const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const loaderUrl = new URL("./core/extensions/loader.js", indexUrl).href;
    const mod = (await import(loaderUrl)) as { clearExtensionCache?: () => void };
    if (typeof mod.clearExtensionCache !== "function") return false;
    mod.clearExtensionCache();
    return true;
  } catch {
    return false;
  }
}
