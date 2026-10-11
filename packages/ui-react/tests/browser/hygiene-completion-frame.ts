import type { Page } from "playwright";

type CompletionFrameGate = {
  pending: Map<number, FrameRequestCallback>;
  release: () => Promise<void>;
};
declare global {
  interface Window {
    __hygieneCompletionFrames?: CompletionFrameGate;
  }
}

/** Keep visibility and completion's scheduled focus observably separate. */
export async function holdCompletionFrames(page: Page) {
  await page.evaluate(() => {
    const frameDescriptor = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
    const cancelDescriptor = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
    const gateDescriptor = Object.getOwnPropertyDescriptor(window, "__hygieneCompletionFrames");
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map<number, FrameRequestCallback>();
    let next = -1;
    const restore = (key: string, descriptor: PropertyDescriptor | undefined) => {
      if (descriptor) Object.defineProperty(window, key, descriptor);
      else Reflect.deleteProperty(window, key);
    };
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true, writable: true,
      value: (callback: FrameRequestCallback) => {
        // Finding entry and native input keep their ordinary frames. Only the
        // mounted completion can be visible while its focus frame is held.
        if (!document.querySelector("[data-hygiene-complete]")) return request(callback);
        const id = next--;
        pending.set(id, callback);
        return id;
      },
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true, writable: true,
      value: (id: number) => { if (!pending.delete(id)) cancel(id); },
    });
    Object.defineProperty(window, "__hygieneCompletionFrames", {
      configurable: true, writable: true,
      value: {
        pending,
        release: async () => {
          await new Promise<void>(resolve => request(time => {
            // Keep cancellation live until the actual frame starts: React may
            // replace the first completion effect with a newer focus signal.
            const callbacks = [...pending.values()];
            pending.clear();
            restore("requestAnimationFrame", frameDescriptor);
            restore("cancelAnimationFrame", cancelDescriptor);
            try { for (const callback of callbacks) callback(time); }
            finally {
              restore("__hygieneCompletionFrames", gateDescriptor);
              resolve();
            }
          }));
        },
      } satisfies CompletionFrameGate,
    });
  });
}

export async function waitForCompletionFrame(page: Page) {
  await page.waitForFunction(() => !!window.__hygieneCompletionFrames?.pending.size);
}

export async function releaseCompletionFrames(page: Page) {
  await page.evaluate(() => window.__hygieneCompletionFrames!.release());
}
