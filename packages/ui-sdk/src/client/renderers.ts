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
  /** Raw input JSON as streamed; absent on history-loaded calls. */
  inputJson?: string;
  status?: "streaming" | "pending_approval" | "approved" | "denied" | "complete";
  startedAt?: number;
  endedAt?: number;
}

/**
 * Backend-neutral meaning extracted from a tool call, for cross-cutting
 * consumers (risk advisories) that must not key on per-backend tool names.
 * Accessors return null/false when the aspect does not apply.
 */
export interface ToolSemantics {
  /** The shell command line this call executes, if it executes one. */
  command?(tool: ToolCallView): string | null;
  /** The filesystem path this call writes or edits, if it writes one. */
  writePath?(tool: ToolCallView): string | null;
  /** True when the call explicitly opts out of its backend's sandbox. */
  unsandboxed?(tool: ToolCallView): boolean;
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
  /** Header label; absent = the caller's default name formatting. */
  label?: string | ((tool: ToolCallView) => string);
  /** File the call touches, for the collapsed run summary. */
  touchedFile?(tool: ToolCallView): string | null;
  /** This tool fans out subagents the timeline should surface live. */
  subagentRows?: boolean;
  /** Backend-neutral meaning, consumed by risk advisories. */
  semantics?: ToolSemantics;
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
  /** Packs already registered, so a second call with the same pack is a no-op. */
  packs: Set<RendererPack>;
}

/**
 * One isolated registry. The module-level functions below drive a default
 * instance; a caller that renders two surfaces with different packs (or a test
 * that must not disturb the default) makes its own.
 */
export interface ToolRendererRegistry {
  /**
   * Register a pack. Registering the SAME pack object twice is a no-op, which
   * is what lets `registerBuiltinRenderers()`-style helpers be idempotent
   * without a module-level latch of their own — a latch survives `reset()` and
   * silently leaves the registry empty for everyone else.
   */
  register(pack: RendererPack): void;
  /** True when this exact pack object is currently registered. */
  has(pack: RendererPack): boolean;
  resolve(tool: ToolCallView, backendId: string): ToolRenderer | null;
  /** Clear every registration, including the registered-pack set. */
  reset(): void;
}

export function createToolRendererRegistry(): ToolRendererRegistry {
  const state: RegistryState = {
    scoped: new Map(),
    global: new Map(),
    predicates: [],
    packs: new Set(),
  };

  return {
    register(pack: RendererPack): void {
      if (state.packs.has(pack)) return;
      state.packs.add(pack);
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
    },

    has(pack: RendererPack): boolean {
      return state.packs.has(pack);
    },

    resolve(tool: ToolCallView, backendId: string): ToolRenderer | null {
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
    },

    reset(): void {
      state.scoped.clear();
      state.global.clear();
      state.predicates.length = 0;
      state.packs.clear();
    },
  };
}

/** The registry the module-level functions drive. */
export const defaultToolRendererRegistry = createToolRendererRegistry();

export function registerToolRenderers(pack: RendererPack): void {
  defaultToolRendererRegistry.register(pack);
}

/** Resolve the renderer for a tool call, or null (caller renders generic). */
export function resolveToolRenderer(
  tool: ToolCallView,
  backendId: string
): ToolRenderer | null {
  return defaultToolRendererRegistry.resolve(tool, backendId);
}

/** Test helper — clears all registrations. */
export function resetToolRenderers(): void {
  defaultToolRendererRegistry.reset();
}
