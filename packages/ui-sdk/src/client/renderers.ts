/**
 * Tool-renderer registry — client side. Registration is BUILD-TIME: the
 * client imports renderer packs in its entry module (one import line per
 * pack); runtime plugin loading into a compiled PWA is deliberately not
 * supported.
 *
 * Resolution order for a tool call:
 *   1. backend-scoped exact name match
 *   2. global exact name match
 *   3. scored predicates (shape-sniffing capability fallbacks live here)
 *   4. null → the caller's generic renderer
 */

import type { ComponentType } from "react";

/** The neutral tool-call shape the client store keeps per tool use. */
export interface ToolCallView {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

export interface ToolRenderer {
  /**
   * string = exact tool name; function = scored predicate (return 0 to pass,
   * higher wins among predicates).
   */
  match: string | ((tool: ToolCallView, backendId: string) => number);
  /** Icon component (e.g. a lucide-react icon). */
  icon?: ComponentType<{ className?: string }>;
  /** One-line summary shown collapsed; null = fall through to default. */
  summary?(tool: ToolCallView): string | null;
  /** Secondary metadata line. */
  meta?(tool: ToolCallView): string | null;
  Input?: ComponentType<{ tool: ToolCallView }>;
  Output?: ComponentType<{ tool: ToolCallView }>;
}

export interface RendererPack {
  /** Restrict this pack's exact-name matches to one backend id. */
  backend?: string;
  renderers: ToolRenderer[];
}

interface RegistryState {
  scoped: Map<string, Map<string, ToolRenderer>>; // backendId -> name -> renderer
  global: Map<string, ToolRenderer>;
  predicates: { renderer: ToolRenderer; fn: (tool: ToolCallView, backendId: string) => number }[];
}

const state: RegistryState = {
  scoped: new Map(),
  global: new Map(),
  predicates: [],
};

export function registerToolRenderers(pack: RendererPack): void {
  for (const renderer of pack.renderers) {
    if (typeof renderer.match === "string") {
      if (pack.backend) {
        let byName = state.scoped.get(pack.backend);
        if (!byName) {
          byName = new Map();
          state.scoped.set(pack.backend, byName);
        }
        byName.set(renderer.match, renderer);
      } else {
        state.global.set(renderer.match, renderer);
      }
    } else {
      state.predicates.push({ renderer, fn: renderer.match });
    }
  }
}

/** Resolve the renderer for a tool call, or null (caller renders generic). */
export function resolveToolRenderer(
  tool: ToolCallView,
  backendId: string
): ToolRenderer | null {
  const scoped = state.scoped.get(backendId)?.get(tool.name);
  if (scoped) return scoped;

  const global = state.global.get(tool.name);
  if (global) return global;

  let best: { renderer: ToolRenderer; score: number } | null = null;
  for (const { renderer, fn } of state.predicates) {
    const score = fn(tool, backendId);
    if (score > 0 && (!best || score > best.score)) {
      best = { renderer, score };
    }
  }
  return best?.renderer ?? null;
}

/** Test helper — clears all registrations. */
export function resetToolRenderers(): void {
  state.scoped.clear();
  state.global.clear();
  state.predicates.length = 0;
}
