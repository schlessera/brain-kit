// Stand-in for `storybook/test`: previews never run play functions, so these only
// need to exist. `fn()` returns a callable no-op so handler args stay functions.
const noop = () => {};
export const fn = (impl?: (...a: any[]) => any) => {
  const f: any = (...a: any[]) => (impl ? impl(...a) : undefined);
  f.mockName = () => f;
  return f;
};
export const expect: any = () => new Proxy({}, { get: () => expect });
export const userEvent: any = new Proxy({}, { get: () => async () => {} });
export const within: any = () => new Proxy({}, { get: () => async () => null });
export const waitFor = async (cb: () => any) => cb();
export const spyOn = () => fn();
export const clearAllMocks = noop;
export const fireEvent: any = new Proxy({}, { get: () => noop });
export const screen: any = new Proxy({}, { get: () => async () => null });
