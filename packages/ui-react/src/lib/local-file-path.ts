/** Safe to hand to the current root's file viewer, never to browser navigation. */
export function openableLocalFilePath(path: string): boolean {
  return Boolean(path) && !/^[\/\\]|^[a-z][a-z\d+.-]*:|[\u0000-\u001f\u007f\\?#]/i.test(path)
    && path.split("/").every(part => part !== ".." && part !== "." && part !== "");
}
