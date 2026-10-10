/** happy-dom models dialog state but has no layout; browser suites prove visibility. */
export function overlayGeometry(): () => void {
  const prototype = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "getClientRects");
  Object.defineProperty(prototype, "getClientRects", {
    configurable: true, writable: true, value: () => [{ width: 1, height: 1 }],
  });
  return () => {
    if (original) Object.defineProperty(prototype, "getClientRects", original);
    else Reflect.deleteProperty(prototype, "getClientRects");
  };
}
