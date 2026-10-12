/** Exact admitted protection, including directory descendants and ancestor replacement. */
export function isProtectedTarget(path: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some(protectedPath => path === protectedPath || path.startsWith(`${protectedPath}/`) || protectedPath.startsWith(`${path}/`));
}
