import type { ConfiguredModule, ContentRendererDeclaration } from "@schlessera/brain-ui-sdk";

/** Project configured metadata only; never import content-named entry points. */
export function declaredContentRenderers(modules: readonly ConfiguredModule[]): ContentRendererDeclaration[] {
  return modules.filter(module => !module.state || module.state === "active").flatMap(module =>
    Object.entries(module.renderers ?? {}).map(([name, renderer]) => ({
      module: module.name, version: module.version ?? null, name,
      fences: renderer.fences ?? [], extensions: renderer.extensions ?? [],
    })));
}
