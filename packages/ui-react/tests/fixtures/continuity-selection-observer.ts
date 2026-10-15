import type { BrainUiRoot } from "../../src/root.ts";
import type { PartitionHandle, PartitionWrite } from "../../src/lib/local-partitions.ts";

// Scoped to the three captured-history snapshot cases. This observes existing operations;
// it never flushes work, replaces native requests, or advances a clock.
export function observeContinuitySelection(root: BrainUiRoot) {
  const partitions = root.partitions!, work = root.localWork!;
  const scope = "root:odysseus-continuity";
  type Context = { sessionId: string; draftId: string; selectionStart: number; selectionEnd: number };
  type Operation = { complete: boolean; published: boolean; context?: Context; forks?: number };
  const operations: Operation[] = [], restores: Array<() => boolean> = [];
  const handles = new WeakSet<PartitionHandle>();
  let active = true, armed = false, errors = 0, account: string | null = null;
  let wanted: Context | undefined, tabKey = "", armIndex = 0, awaitingPublication: Operation | undefined;
  const observe = (fn: () => void) => { if (active) try { fn(); } catch { errors++; } };
  function replace<T extends object, K extends keyof T>(owner: T, key: K, value: T[K]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const original = owner[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.configurable || !descriptor.writable) throw new Error("Expected an owned writable data method");
    Object.defineProperty(owner, key, { ...descriptor, value });
    restores.push(() => {
      if (descriptor) Object.defineProperty(owner, key, descriptor); else delete owner[key];
      const restored = Object.getOwnPropertyDescriptor(owner, key);
      return owner[key] === original && (descriptor === undefined ? restored === undefined : restored !== undefined
        && (["value", "writable", "get", "set", "enumerable", "configurable"] as const).every(k => descriptor[k] === restored[k]));
    });
  }
  const offAccount = root.stores.connection.subscribe(state => observe(() => {
    if (armed && state.accountKey !== account) errors++;
  }));
  const offAuth = root.authLock.state.subscribe(state => observe(() => {
    if (armed && state.phase !== "active") errors++;
  }));
  function dispose() {
    active = false; offAccount(); offAuth();
    let restored = true;
    for (const restore of restores.splice(0).reverse()) try { restored = restore() && restored; } catch { restored = false; }
    return { restored, active };
  }
  try {
    if (!partitions || !work || root.stores.connection.getState().accountKey !== null) throw new Error("Selection observer must precede account binding");
    const open = partitions.open;
    replace(partitions, "open", function(this: typeof partitions, ...args: Parameters<typeof open>) {
      const handle = Reflect.apply(open, this, args);
      observe(() => {
        if (handles.has(handle)) return;
        handles.add(handle);
        const mutate = handle.mutate;
        replace(handle, "mutate", function<T>(this: PartitionHandle, ...args: [prefix: string,
          update: (rows: Array<{ key: string; value: unknown }>) => { changes: readonly PartitionWrite[]; result: T }, signal?: AbortSignal]): Promise<T> {
          const [prefix, update] = args;
          let operation: Operation | undefined;
          observe(() => {
            if (prefix !== `${scope}/draft/`) return;
            if (operations.length >= 64 || (armed && handle.id !== `account:${account}`)) { errors++; return; }
            operation = { complete: false, published: false }; operations.push(operation);
          });
          // Callback identity changes; its this/arguments and returned plan do not.
          const callback: typeof update = function(this: unknown, ...values) {
            const plan = Reflect.apply(update, this, values);
            observe(() => {
              if (!operation) return;
              const change = plan.changes.find(c => "put" in c && c.put === tabKey);
              if (change && "put" in change) {
                const c = change.value as Context;
                operation.context = { sessionId: c.sessionId, draftId: c.draftId, selectionStart: c.selectionStart, selectionEnd: c.selectionEnd };
              }
            });
            return plan;
          };
          const forwarded = [...args] as typeof args; forwarded[1] = callback;
          const promise = Reflect.apply(mutate, this, forwarded) as Promise<T>;
          // Return the ORIGINAL promise. Both observers are nonthrowing; native
          // transaction completion precedes the caller's await continuation.
          void promise.then(result => observe(() => {
            if (!operation) return;
            operation.complete = true;
            operation.forks = (result as { forks?: unknown[] }).forks?.length;
            if (awaitingPublication) errors++;
            awaitingPublication = operation;
          }), () => observe(() => { if (operation) errors++; }));
          return promise;
        });
      });
      return handle;
    });
    const setState = work.status.setState;
    replace(work.status, "setState", function(this: typeof work.status, ...args: Parameters<typeof setState>) {
      const result = Reflect.apply(setState, this, args);
      observe(() => {
        const patch = args[0];
        if (typeof patch !== "object" || patch === null) { errors++; return; }
        if (patch.failed === true) errors++;
        // flushLocked's normal postcommit publication has BOTH keys. changed,
        // lock and zero-change flush only publish pending; failures set failed.
        if (patch.failed === false && typeof patch.pending === "boolean") {
          if (!awaitingPublication) { errors++; return; }
          awaitingPublication.published = true; awaitingPublication = undefined;
        }
      });
      return result;
    } as typeof setState);
    const lock = work.lock;
    replace(work, "lock", function(this: typeof work, ...args: Parameters<typeof lock>) {
      observe(() => { if (armed) errors++; });
      return Reflect.apply(lock, this, args);
    });
    return {
      arm(sessionId: string, draftId: string) {
        account = root.stores.connection.getState().accountKey;
        const tab = sessionStorage.getItem(`brain-ui:work-tab:${scope}`);
        if (armed || !account || !tab || root.authLock.state.getState().phase !== "active") errors++;
        tabKey = `${scope}/context/${tab}`;
        armIndex = operations.length;
        wanted = { sessionId, draftId, selectionStart: 6, selectionEnd: 12 }; armed = true;
      },
      ready() {
        const matches = (c?: Context) => c !== undefined && wanted !== undefined
          && (Object.keys(wanted) as Array<keyof Context>).every(k => c[k] === wanted![k]);
        return active && armed && errors === 0 && matches(operations.slice(armIndex).findLast(op => op.context)?.context)
          && operations.every(op => op.complete && op.published && op.forks === 0)
          && !work.status.getState().failed && !work.status.getState().pending;
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
