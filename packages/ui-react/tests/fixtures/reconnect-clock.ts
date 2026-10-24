/** Control the last timer registered by the client's synchronous onclose.
 * Its verified final operation is scheduleReconnect. Other close-handler
 * timers, Date, Motion, media and native storage keep their original clocks.
 */
export function reconnectClock() {
  const owners = [[window, "setTimeout"], [window, "clearTimeout"]] as const;
  const descriptors = owners.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key)!);
  if (descriptors.some(descriptor => !descriptor || !("value" in descriptor)))
    throw new Error("Expected owned browser timer methods");
  const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
  type Timer = { handle: number; native: number; delay: number; due: number; close: number;
    fired: number; cleared: boolean; held: boolean; callback: Function; args: unknown[] };
  type Scope = { id: number; timers: Timer[] };
  const timers = new Map<number, Timer>(), restorers: Array<() => void> = [], socketChecks: Array<() => boolean> = [];
  let paused = false, now = 0, closes = 0, scope: Scope | undefined, errors = 0, disposed = false;
  const pending = () => [...timers.values()].filter(timer => !timer.fired && !timer.cleared);
  const fire = (timer: Timer) => {
    clear(timer.native);
    timer.fired++;
    return Reflect.apply(timer.callback, window, timer.args);
  };
  const same = (actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined) =>
    expected === undefined ? actual === undefined : actual !== undefined
      && (["value", "writable", "enumerable", "configurable", "get", "set"] as const)
        .every(field => actual[field] === expected[field]);
  try {
    Object.defineProperty(window, "setTimeout", { ...descriptors[0], value:
      function(callback: TimerHandler, delay = 0, ...args: unknown[]) {
        if (!scope) return set(callback, delay, ...args);
        if (typeof callback !== "function" || !Number.isFinite(delay) || delay < 0) {
          errors++;
          return set(callback, delay, ...args);
        }
        const timer: Timer = { handle: 0, native: 0, delay, due: now + delay, close: scope.id,
          fired: 0, cleared: false, held: false, callback, args };
        timer.handle = timer.native = set(() => { if (!timer.held) fire(timer); }, delay);
        scope.timers.push(timer);
        return timer.handle;
      } });
    Object.defineProperty(window, "clearTimeout", { ...descriptors[1], value: function(handle?: number) {
      const timer = handle === undefined ? undefined : timers.get(handle) ?? scope?.timers.find(timer => timer.handle === handle);
      if (timer) { timer.cleared = true; clear(timer.native); }
      clear(handle);
    } });
  } catch (error) {
    owners.forEach(([owner, key], index) => Object.defineProperty(owner, key, descriptors[index]!));
    throw error;
  }
  return {
    observe(socket: WebSocket) {
      if (disposed) return;
      const own = Object.getOwnPropertyDescriptor(socket, "onclose");
      let owner: object | null = socket;
      while (owner && !Object.getOwnPropertyDescriptor(owner, "onclose")) owner = Object.getPrototypeOf(owner);
      const original = owner && Object.getOwnPropertyDescriptor(owner, "onclose");
      if (!original) throw new Error("Expected an existing socket close property");
      let assigned = socket.onclose, wrapped = assigned;
      Object.defineProperty(socket, "onclose", { configurable: true, enumerable: original.enumerable,
        get: () => wrapped,
        set(value: typeof socket.onclose) {
          assigned = value;
          wrapped = value === null ? null : function(this: WebSocket, event: CloseEvent) {
            if (!paused) return value.call(this, event);
            const previous = scope, current: Scope = { id: ++closes, timers: [] };
            scope = current;
            try { return value.call(this, event); }
            finally {
              scope = previous;
              // The installed client schedules its reconnect LAST, after all
              // synchronous status callbacks. Default 1s/2s/4s registrations
              // are asserted independently at every native failed handshake.
              const timer = current.timers.at(-1);
              if (timer && !timer.cleared && !timer.fired) {
                if (timers.size >= 128) errors++;
                else { timer.held = true; timers.set(timer.handle, timer); }
              }
            }
          };
          original.set?.call(socket, wrapped);
        } });
      restorers.push(() => {
        if (own) Object.defineProperty(socket, "onclose", "value" in own ? { ...own, value: assigned } : own);
        else Reflect.deleteProperty(socket, "onclose");
        original.set?.call(socket, assigned);
      });
      socketChecks.push(() => same(Object.getOwnPropertyDescriptor(socket, "onclose"), own && "value" in own ? { ...own, value: assigned } : own)
        && socket.onclose === assigned);
    },
    pause() {
      if (disposed || paused || pending().length) throw new Error("Reconnect clock has unsettled ownership");
      paused = true;
    },
    snapshot: () => ({ errors, paused, delivering: scope !== undefined,
      pending: pending().map(({ delay, due, close }) => ({ delay, due, close })),
      timers: [...timers.values()].map(({ delay, due, close, fired, cleared }) => ({ delay, due, close, fired, cleared })) }),
    advance(ms: number) {
      if (!paused || !Number.isSafeInteger(ms) || ms < 0) throw new Error("Invalid reconnect clock advance");
      now += ms;
      for (const timer of pending().filter(timer => timer.due <= now)) fire(timer);
    },
    resume() {
      if (!paused) return;
      paused = false;
      for (const timer of pending()) {
        clear(timer.native);
        timer.held = false;
        timer.native = set(() => fire(timer), Math.max(0, timer.due - now));
      }
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        for (const timer of pending()) clear(timer.native);
        for (const restore of restorers.reverse()) restore();
        owners.forEach(([owner, key], index) => Object.defineProperty(owner, key, descriptors[index]!));
      }
      return { restored: socketChecks.every(check => check()) && owners.every(([owner, key], index) =>
        same(Object.getOwnPropertyDescriptor(owner, key), descriptors[index])), errors };
    },
  };
}
