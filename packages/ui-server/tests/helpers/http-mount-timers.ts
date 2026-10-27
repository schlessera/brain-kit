import { expect, spyOn } from "bun:test";
import { globalAgent } from "node:http";
import { Socket } from "node:net";
import type { HttpContractApp } from "./http-contract-app";

type SocketSnapshot = {
  id: number | null; ownedAgentKeys: string[]; destroyed: boolean; closed: boolean;
  connecting: boolean; pending: boolean; timeout?: number; readable: boolean; writable: boolean;
};
type MountTimerSnapshot = {
  phase: string; pending: number;
  handles: Array<{ id: number | null; type: string; prototype?: string; nativeDestroyed: boolean | "unknown";
    hasRef: boolean | "unknown"; ownProperties: string[]; kind?: string; delay?: unknown;
    callback: { id: number | null; name: string; source: string | null }; socket: SocketSnapshot | null }>;
  sockets: SocketSnapshot[];
  ownedAgents: Array<{ key: string; active: SocketSnapshot[]; free: SocketSnapshot[]; queuedRequests: number }>;
};

/** Observe real timers, including unref'ed ones Bun's active-resource API omits. */
export function observeMountTimers() {
  const observed = new Set<ReturnType<typeof setTimeout>>();
  // Retain references only on the hot path: no stacks, callback wrapping,
  // event listeners or asynchronous diagnostic work. Read native state only
  // when a zero oracle fails, before its finally block changes that evidence.
  const registrations = new Map<ReturnType<typeof setTimeout>, { callback: unknown; delay: unknown; kind: string; socket?: Socket }>();
  const sockets = new Map<Socket, Set<string>>();
  const ownedKeys = new Set<string>();
  let currentSocket: Socket | undefined;
  const socketDescriptor = Object.getOwnPropertyDescriptor(Socket.prototype, "setTimeout")!;
  const socketTimeout = Socket.prototype.setTimeout;
  const socketSpy = spyOn(Socket.prototype, "setTimeout").mockImplementation(function (this: Socket, ...args: Parameters<Socket["setTimeout"]>) {
    const previous = currentSocket;
    // oxlint-disable-next-line typescript/no-this-alias -- Preserve synchronous socket ownership while forwarding the native call unchanged.
    currentSocket = this;
    let keys = sockets.get(this);
    if (!keys) sockets.set(this, keys = new Set());
    for (const table of [globalAgent.sockets, globalAgent.freeSockets]) {
      for (const key of ownedKeys) if (table[key]?.includes(this)) keys.add(key);
    }
    try { return Reflect.apply(socketTimeout, this, args); }
    finally { currentSocket = previous; }
  });
  const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const intervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval")!;
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const handle = Reflect.apply(timeout, globalThis, args);
    observed.add(handle);
    registrations.set(handle, { callback: args[0], delay: args[1], kind: "timeout", socket: currentSocket });
    return handle;
  }) as typeof setTimeout);
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const handle = Reflect.apply(interval, globalThis, args);
    observed.add(handle);
    registrations.set(handle, { callback: args[0], delay: args[1], kind: "interval", socket: currentSocket });
    return handle;
  }) as typeof setInterval);
  const observer: {
    readonly pending: Set<ReturnType<typeof setTimeout>>;
    own(fixture: HttpContractApp): void;
    expectEmpty(phase: string): void;
    snapshot(phase: string, pending?: Set<ReturnType<typeof setTimeout>>): MountTimerSnapshot;
    restore(): void;
  } = {
    get pending(): Set<ReturnType<typeof setTimeout>> {
      // Bun 1.4.2's native Timeout getter reports cancellation even when an
      // imported clear function, close() or socket destruction bypasses a
      // global clear spy. Keep unknown states observed. Retain every handle
      // so refresh() can reactivate a fired timeout. No owner,
      // stack, ref state or delay exempts a live timer (including keepalive).
      return new Set([...observed].filter(handle =>
        (handle as unknown as { readonly _destroyed?: boolean })._destroyed !== true));
    },
    own(fixture: HttpContractApp) {
      const key = globalAgent.getName({ socketPath: fixture.app.config.nativeBrain!.socketPath, port: 80 });
      ownedKeys.add(key);
      // Startup can arm sockets before prepare returns the fixture identity.
      for (const socket of [...(globalAgent.sockets[key] ?? []), ...(globalAgent.freeSockets[key] ?? [])]) {
        let keys = sockets.get(socket);
        if (!keys) sockets.set(socket, keys = new Set());
        keys.add(key);
      }
    },
    expectEmpty(phase: string): void {
      const pending = observer.pending;
      // The ordinary count assertion remains the oracle; diagnostics neither
      // filter nor wait for any handle. Successful assertions allocate no JSON.
      const message = pending.size ? `HTTP_MOUNT_PENDING_TIMERS ${JSON.stringify(observer.snapshot(phase, pending))}` : phase;
      expect(pending.size, message).toBe(0);
    },
    snapshot(phase: string, pending: Set<ReturnType<typeof setTimeout>> = observer.pending): MountTimerSnapshot {
      const ids = new Map<unknown, number>();
      const identity = (value: unknown) => {
        if (value === undefined || value === null) return null;
        if (!ids.has(value)) ids.set(value, ids.size + 1);
        return ids.get(value)!;
      };
      const socketState = (socket: Socket) => ({
        id: identity(socket), ownedAgentKeys: [...(sockets.get(socket) ?? [])],
        destroyed: socket.destroyed, closed: socket.closed, connecting: socket.connecting,
        pending: socket.pending, timeout: socket.timeout, readable: socket.readable, writable: socket.writable,
      });
      return { phase, pending: pending.size, handles: [...pending].map(handle => {
        const native = handle as unknown as { _destroyed?: boolean; hasRef?: () => boolean };
        const registration = registrations.get(handle);
        return { id: identity(handle), type: typeof handle, prototype: Object.getPrototypeOf(handle)?.constructor?.name,
          nativeDestroyed: native._destroyed ?? "unknown", hasRef: native.hasRef?.() ?? "unknown",
          ownProperties: Reflect.ownKeys(Object(handle)).map(String),
          kind: registration?.kind, delay: registration?.delay,
          callback: { id: identity(registration?.callback), name: typeof registration?.callback === "function" ? registration.callback.name : typeof registration?.callback,
            // Read code only while taking a diagnostic snapshot. An anonymous
            // live callback cannot be attributed from its name or delay alone.
            source: typeof registration?.callback === "function" ? Function.prototype.toString.call(registration.callback) : null },
          socket: registration?.socket ? socketState(registration.socket) : null };
      }), sockets: [...sockets.keys()].map(socketState), ownedAgents: [...ownedKeys].map(key => ({ key,
        active: (globalAgent.sockets[key] ?? []).map(socketState), free: (globalAgent.freeSockets[key] ?? []).map(socketState),
        queuedRequests: globalAgent.requests[key]?.length ?? 0,
      })) };
    },
    restore() {
      timeoutSpy.mockRestore(); intervalSpy.mockRestore(); socketSpy.mockRestore();
      Object.defineProperty(Socket.prototype, "setTimeout", socketDescriptor);
      Object.defineProperty(globalThis, "setTimeout", timeoutDescriptor);
      Object.defineProperty(globalThis, "setInterval", intervalDescriptor);
    },
  };
  return observer;
}
