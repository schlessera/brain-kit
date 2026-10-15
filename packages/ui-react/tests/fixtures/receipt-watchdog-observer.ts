/** One lost-receipt case: correlate timers with successful native sends on the same stack. */
export function installReceiptWatchdogObserver(requestId: string) {
  type Scope = { id: number; type: string; requestId?: string; submissionId?: string; probeId?: string; timers: number[] };
  type Timer = { id: number; scope: number; delay: number; at: number; fired: number; clears: number };
  const sends: Scope[] = [], timers: Timer[] = [];
  const handles = new Map<number, Timer>();
  // Playwright routing exposes a subclass whose send method is inherited.
  let sendOwner: object | null = WebSocket.prototype, sendOwnerDepth = 0;
  while (sendOwner && !Object.getOwnPropertyDescriptor(sendOwner, "send")) {
    sendOwner = Object.getPrototypeOf(sendOwner); sendOwnerDepth++;
  }
  const sendDescriptor = sendOwner && Object.getOwnPropertyDescriptor(sendOwner, "send");
  if (!sendOwner || !sendDescriptor || !("value" in sendDescriptor) || sendDescriptor.value !== WebSocket.prototype.send)
    throw new Error("Expected existing routed socket send method");
  const owners = [[window, "setTimeout"], [window, "clearTimeout"], [sendOwner, "send"]] as const;
  const diagnosticDescriptor = Object.getOwnPropertyDescriptor(window, "__receiptTimers");
  const descriptors = owners.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key)!);
  const set = window.setTimeout, clear = window.clearTimeout, send = WebSocket.prototype.send;
  let current: Scope | undefined, executing: Scope | undefined, errors = 0, active = true;
  const observe = (fn: () => void) => { if (active) try { fn(); } catch { errors++; } };
  const replace = (index: number, value: unknown) => {
    const [owner, key] = owners[index]!;
    const descriptor = descriptors[index]!;
    if (!descriptor || !("value" in descriptor)) throw new Error("Expected owned timer/socket method");
    Object.defineProperty(owner, key, { ...descriptor, value });
  };
  const dispose = () => {
    active = false; current = undefined;
    window.removeEventListener("pagehide", dispose);
    let restored = true;
    owners.forEach(([owner, key], index) => {
      try {
        Object.defineProperty(owner, key, descriptors[index]!);
        const actual = Object.getOwnPropertyDescriptor(owner, key)!;
        restored = restored && ["value", "writable", "enumerable", "configurable", "get", "set"].every(k =>
          actual[k as keyof PropertyDescriptor] === descriptors[index]![k as keyof PropertyDescriptor]);
      } catch { restored = false; }
    });
    if (diagnosticDescriptor) Object.defineProperty(window, "__receiptTimers", diagnosticDescriptor);
    else delete (window as unknown as Record<string, unknown>).__receiptTimers;
    const actualDiagnostic = Object.getOwnPropertyDescriptor(window, "__receiptTimers");
    restored = restored && (diagnosticDescriptor === undefined ? actualDiagnostic === undefined : actualDiagnostic !== undefined
      && ["value", "writable", "enumerable", "configurable", "get", "set"].every(k => actualDiagnostic[k as keyof PropertyDescriptor] === diagnosticDescriptor[k as keyof PropertyDescriptor]));
    return { restored, errors };
  };
  try {
    replace(2, function(this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
      const result = Reflect.apply(send, this, args); // A throwing send does not establish ownership.
      observe(() => {
        if (typeof args[0] !== "string") return;
        const frame = JSON.parse(args[0]);
        if (frame.type === "ping") {
          if (executing?.requestId !== requestId) return;
        } else if (!["ask_user_response", "ask_answer_status"].includes(frame.type) || frame.requestId !== requestId) return;
        if (sends.length >= 16) { errors++; return; }
        const scope: Scope = { id: sends.length, type: frame.type, requestId: frame.requestId,
          submissionId: frame.submissionId, probeId: frame.probeId, timers: [] };
        sends.push(scope); current = scope;
        queueMicrotask(() => { if (current === scope) current = undefined; });
      });
      return result;
    });
    replace(0, function(this: Window, ...args: Parameters<Window["setTimeout"]>) {
      const scope = current;
      if (!scope || !active) return Reflect.apply(set, this, args);
      const original = args[0];
      if (typeof original !== "function" || timers.length >= 16) { errors++; return Reflect.apply(set, this, args); }
      const timer: Timer = { id: timers.length, scope: scope.id, delay: Number(args[1] ?? 0), at: Date.now(), fired: 0, clears: 0 };
      timers.push(timer); scope.timers.push(timer.id);
      const forwarded = [...args] as Parameters<Window["setTimeout"]>;
      forwarded[0] = function(this: unknown, ...values: unknown[]) {
        observe(() => { timer.fired++; });
        const prior = executing; executing = scope;
        try { return Reflect.apply(original, this, values); } finally { executing = prior; }
      };
      const handle = Reflect.apply(set, this, forwarded);
      handles.set(handle, timer);
      return handle;
    });
    replace(1, function(this: Window, ...args: Parameters<Window["clearTimeout"]>) {
      const result = Reflect.apply(clear, this, args);
      observe(() => { const timer = handles.get(args[0]!); if (timer) timer.clears++; });
      return result;
    });
    Object.assign(window, { __receiptTimers: { snapshot: () => ({ sends, timers, errors, sendOwner: { depth: sendOwnerDepth, writable: sendDescriptor.writable, enumerable: sendDescriptor.enumerable, configurable: sendDescriptor.configurable } }), dispose } });
    window.addEventListener("pagehide", dispose, { once: true });
  } catch (error) { dispose(); throw error; }
}
