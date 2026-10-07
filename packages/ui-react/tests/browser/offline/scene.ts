/**
 * Page-level fault primitives, browser side (#1016): open a scene, call into
 * it, reload it, terminate it. The Node side and the reasons are in
 * `scene-commands.ts`.
 *
 * A scene is a module that calls `defineScene` (`define-scene.ts`, which
 * imports nothing from Vitest: a scene page has no runner) with the actions a
 * test may call. Arguments and results cross a process boundary, so they must
 * be JSON-like. Close the scene when the test ends:
 *
 *   const s = await openScene(new URL("./scenes/answers.scene.ts", import.meta.url));
 *   ctx.onTestFinished(() => s.close());
 *   await s.call("save", "ithaca");
 *   await s.terminate();
 *   expect(await s.call("saved")).toEqual(["ithaca"]);
 */
import { commands } from "vitest/browser";
import type { SceneOp } from "./scene-commands.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    offlineScene: (request: SceneOp) => Promise<unknown>;
  }
}

export interface SceneHandle {
  /** Run one of the scene's actions and return its (awaited) result. */
  call<T = unknown>(action: string, ...args: unknown[]): Promise<T>;
  /** Another tab sharing this scene's origin and browser storage. */
  sibling(): Promise<SceneHandle>;
  /** A user's reload. Resolves once the reloaded scene has registered again. */
  reload(): Promise<void>;
  /** Kill the renderer with no unload handler running, then launch the scene again. */
  terminate(): Promise<void>;
  close(): Promise<void>;
}

export async function openScene(module: URL): Promise<SceneHandle> {
  const id = (await commands.offlineScene({ op: "open", module: module.pathname })) as string;
  return sceneHandle(id);
}

function sceneHandle(id: string): SceneHandle {
  return {
    async sibling() { return sceneHandle(await commands.offlineScene({ op: "sibling", id }) as string); },
    async call<T>(action: string, ...args: unknown[]) {
      return (await commands.offlineScene({ op: "call", id, action, args })) as T;
    },
    async reload() {
      await commands.offlineScene({ op: "reload", id });
    },
    async terminate() {
      await commands.offlineScene({ op: "terminate", id });
    },
    async close() {
      await commands.offlineScene({ op: "close", id });
    },
  };
}
