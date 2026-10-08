/**
 * Inside a scene module (#1016): register the actions a test may call through
 * `openScene(...).call(name, ...args)`. A scene page has no Vitest runner, so
 * this file imports nothing.
 */
export function defineScene(actions: Record<string, (...args: never[]) => unknown>): void {
  (globalThis as unknown as { __offlineScene: unknown }).__offlineScene = actions;
}
