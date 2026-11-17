// Throwaway measurement probe for #4116. Never committed.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

const moduleEvaluation = Math.random().toString(36).slice(2, 8);
let moduleCounter = 0, beforeAllCalls = 0, beforeEachCalls = 0, afterEachCalls = 0;
const repeats = Number((import.meta as any).env?.VITE_PROBE_REPEATS ?? 0);

const idbCount = () => new Promise<number>((resolve, reject) => {
  const open = indexedDB.open("probe", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("s");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction("s", "readwrite"), store = tx.objectStore("s"), get = store.get("n");
    get.onsuccess = () => { const next = (get.result ?? 0) + 1; store.put(next, "n"); tx.oncomplete = () => { open.result.close(); resolve(next); }; };
  };
});

beforeAll(() => { beforeAllCalls++; });
beforeEach(() => { beforeEachCalls++; });
afterEach(() => { afterEachCalls++; });

describe("probe", { repeats }, () => {
  test("state", async ({ task }) => {
    moduleCounter++;
    const g = globalThis as any;
    g.__probeGlobal = (g.__probeGlobal ?? 0) + 1;
    let parentCounter: number | string = "n/a";
    try { const p = window.parent as any; if (p !== window) { p.__probeParent = (p.__probeParent ?? 0) + 1; parentCounter = p.__probeParent; } } catch (error) { parentCounter = "blocked"; }
    localStorage.setItem("probe", String(Number(localStorage.getItem("probe") ?? 0) + 1));
    sessionStorage.setItem("probe", String(Number(sessionStorage.getItem("probe") ?? 0) + 1));
    const cookie = Number(/probe=(\d+)/.exec(document.cookie)?.[1] ?? 0) + 1;
    document.cookie = `probe=${cookie}; path=/`;
    const leftover = document.querySelectorAll("[data-probe]").length;
    document.body.append(Object.assign(document.createElement("div"), { textContent: "probe" }));
    document.body.lastElementChild!.setAttribute("data-probe", "");
    const idb = await idbCount();
    console.info("PROBE4116", JSON.stringify({
      moduleEvaluation, moduleCounter, global: g.__probeGlobal, parentCounter,
      local: localStorage.getItem("probe"), session: sessionStorage.getItem("probe"), cookie, idb, leftoverDom: leftover,
      beforeAllCalls, beforeEachCalls, afterEachCalls,
      repeatCount: task.result?.repeatCount, timeOrigin: Math.round(performance.timeOrigin),
      sessionId: new URL(location.href).searchParams.get("sessionId")?.slice(0, 8), framed: window.parent !== window,
      cores: navigator.hardwareConcurrency,
    }));
    expect(true).toBe(true);
  });
});
