import { registerContentRenderers, type ContentRendererPack } from "@schlessera/brain-ui-sdk/client";
import type { ContentRendererDeclaration } from "@schlessera/brain-ui-sdk";

const versions = new Map<string, string>();
/** @experimental Register trusted module UI code imported by the deployment build, before rendering. */
export function registerContentRendererPack(pack: ContentRendererPack, module: { name: string; version: string }): void {
  registerContentRenderers(pack);
  if (!versions.has(module.name)) versions.set(module.name, module.version);
}
/** Each root owns its warning receipts; production never emits a skew warning. */
export function warnContentRendererVersions(declarations: readonly ContentRendererDeclaration[], development: boolean, warned: Set<string>): void {
  if (!development) return;
  for (const declaration of declarations) {
    const bundled = versions.get(declaration.module);
    if (!bundled || !declaration.version || bundled === declaration.version) continue;
    const key = JSON.stringify([declaration.module, bundled, declaration.version]);
    if (warned.has(key)) continue;
    warned.add(key);
    console.warn(`Content renderer module ${declaration.module}: bundled ${bundled}, server ${declaration.version}. Rebuild the client to align versions.`);
  }
}
