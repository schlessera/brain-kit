import { createContext, Suspense, useContext, type ReactNode } from "react";
import { defaultContentRendererRegistry, type ContentRenderer, type ContentRendererProps } from "@schlessera/brain-ui-sdk/client";
import { useColorScheme } from "../hooks/use-color-scheme.js";
import { ErrorBoundary } from "./layout/error-boundary.js";

/** Surface context also reaches nested markdown fences without changing the parser. */
export const ContentRendererSurface = createContext<{ mode: ContentRendererProps["mode"]; path?: string }>({ mode: "chat" });
/** Server declarations are connected by the host's bundling integration. */
export const ContentRendererDeclarations = createContext<readonly { fences?: readonly string[]; extensions?: readonly string[] }[]>([]);

/** Longest exact suffix wins, so .diagram.yaml precedes .yaml. */
export function rendererForPath(path: string): ContentRenderer | null {
  const name = path.split("/").pop() ?? path;
  for (let index = name.indexOf("."); index >= 0; index = name.indexOf(".", index + 1)) {
    const renderer = defaultContentRendererRegistry.forExtension(name.slice(index));
    if (renderer) return renderer;
  }
  return null;
}

export function ContentRendererView({ source, language, path, fallback }: { source: string; language?: string; path?: string; fallback: ReactNode }) {
  const surface = useContext(ContentRendererSurface);
  const declarations = useContext(ContentRendererDeclarations);
  const effectivePath = path ?? surface.path;
  const renderer = language ? defaultContentRendererRegistry.forLanguage(language) : path ? rendererForPath(path) : null;
  const declared = declarations.some(entry => language ? entry.fences?.includes(language) : path && entry.extensions?.some(extension => path.endsWith(extension)));
  if (!renderer) return <>{fallback}{declared && <p role="status">Renderer not bundled.</p>}</>;
  return <RenderedContent key={`${language ?? path}`} renderer={renderer} source={source} path={effectivePath} mode={surface.mode} fallback={fallback} />;
}

function RenderedContent({ renderer, source, path, mode, fallback }: { renderer: ContentRenderer; source: string; path?: string; mode: ContentRendererProps["mode"]; fallback: ReactNode }) {
  const scheme = useColorScheme();
  // A build supplies React.lazy(import(...)) for each heavy pack. Render it
  // directly: nesting lazy around an already-lazy component is invalid React.
  const Component = renderer.Component;
  return <ErrorBoundary resetKeys={[renderer, source, path, mode]} fallback={() => <>{fallback}<p role="status">Renderer failed. Showing source code.</p></>}>
    <Suspense fallback={fallback}><Component source={source} path={path} mode={mode} theme={mode === "share" ? "print" : scheme} /></Suspense>
  </ErrorBoundary>;
}
