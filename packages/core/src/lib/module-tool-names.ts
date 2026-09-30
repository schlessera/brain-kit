/** Internal naming rules shared by manifest loading and module lint. */
export const MODULE_TOOL_MODULE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const MODULE_TOOL_LOCAL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const MODULE_TOOL_LOCAL_NAME_MESSAGE = "tool local name must match ^[a-z][a-z0-9_]{0,31}$ (max 32 chars)";

export function moduleToolNameIssues(moduleName: string, localNames: string[]): string[] {
  if (localNames.length === 0) return [];
  const issues: string[] = [];
  if (moduleName === "brain") issues.push('tools: module name "brain" is reserved for core tools');
  if (!MODULE_TOOL_MODULE_NAME.test(moduleName)) {
    issues.push("tools: module name must match ^[a-z][a-z0-9-]{0,30}$ (max 31 chars)");
  }
  for (const local of localNames) {
    if (!MODULE_TOOL_LOCAL_NAME.test(local)) issues.push(`tools.${local}: ${MODULE_TOOL_LOCAL_NAME_MESSAGE}`);
  }
  return issues;
}

/** Keep a rejected declaration available as a lint diagnostic, without loading it. */
export class ModuleToolNameError extends Error {
  constructor(readonly moduleName: string, readonly issues: string[]) {
    super(`Module "${moduleName}" contributed an invalid manifest:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
  }
}
