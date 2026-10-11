/**
 * The resource loader of a restricted autonomous turn (#676, R29): no project
 * or user settings, extensions, skills, prompt templates, themes, context
 * files or SYSTEM.md. The only instructions are the server's immutable
 * snapshot. The permission gate is an inline factory, so it is still
 * installed and enforces the roster.
 */
import { DefaultResourceLoader, SettingsManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AutonomousTurnOptions } from "@schlessera/brain-ui-sdk/server";

export async function restrictedResources(brainPath: string, agentDir: string, autonomous: AutonomousTurnOptions,
  sandboxNote: string | undefined, permissionGate: InlineExtension): Promise<{ loader: DefaultResourceLoader; settingsManager: SettingsManager }> {
  const settingsManager = SettingsManager.inMemory({});
  // The server's snapshot, then the note it rendered from the worker's mounts (#1626).
  const append = [autonomous.systemPromptAppend, sandboxNote].filter(Boolean).join("\n\n");
  const loader = new DefaultResourceLoader({
    cwd: brainPath, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [permissionGate],
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => append ? [append] : [],
  });
  await loader.reload();
  return { loader, settingsManager };
}
