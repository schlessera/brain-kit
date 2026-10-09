import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectPng, launchCaptureBrowser } from "./browser.ts";
import type { Catalogue } from "./catalogue.ts";
import { APPROVAL_CONTENT } from "./fixture-data.ts";
import { captureRuntime } from "./runtime.ts";

type Cause = { name: string; message: string; stack?: string };
type Failure = {
  detected_at: string;
  faults: string[];
  browserState?: { errors?: Array<{ chain: Cause[] }>; text?: string };
  consoleErrors?: Array<Array<{ chain?: Cause[] }>>;
  hostEvidence?: { files?: Array<{ path: string }> };
};

/** Real native faults must remain failures and retain their original causes. */
export async function checkFaultEvidence(root: string, cache: string, catalogue: Catalogue, output: string) {
  assert(APPROVAL_CONTENT.trim().length > 0, "fault evidence needs a nonempty actual approval input");
  const recipe = catalogue.harness_requirements.find(entry => entry.id === "approval-roundtrip")!;
  const results: Array<{ mode: string; rejected: true; cause_retained: true }> = [];
  for (const mode of ["window", "console"] as const) {
    const directory = resolve(output, "fault-evidence", mode);
    await mkdir(directory, { recursive: true });
    const browser = await launchCaptureBrowser();
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      await context.addInitScript(mode => {
        window.addEventListener("DOMContentLoaded", () => {
          const error = new Error("odysseus-capture-wrapper", { cause: new TypeError("odysseus-capture-original") });
          // React's default recovered-error handler uses native reportError.
          // The fixed browser clock reports thrown timer errors to console.
          if (mode === "window") reportError(error);
          else setTimeout(() => { throw error; }, 0);
        }, { once: true });
      }, mode);
      return context;
    };
    try {
      let failure: Error | undefined;
      try { await captureRuntime(browser, root, cache, catalogue, recipe, directory); }
      catch (error) { failure = error as Error; }
      assert(failure?.message.includes("odysseus-capture-wrapper"), `${mode}: browser fault was admitted or rejected for another reason: ${failure?.message ?? "no failure"}`);
      const data = JSON.parse(await readFile(resolve(directory, "approval-roundtrip-failure.json"), "utf8")) as Failure;
      assert(data.faults.length > 0 && data.faults.every(fault => fault.includes("odysseus-capture-wrapper")), `${mode}: expected injected faults only`);
      const chains = mode === "window"
        ? (data.browserState?.errors ?? []).map(error => error.chain)
        : (data.consoleErrors ?? []).flatMap(group => group.map(error => error.chain ?? []));
      assert(chains.some(chain => chain.length === 2
        && chain[0]?.name === "Error" && chain[0].message === "odysseus-capture-wrapper"
        && chain[1]?.name === "TypeError" && chain[1].message === "odysseus-capture-original"
        && chain.every(error => !!error.stack)), `${mode}: nested error cause/stack evidence missing`);
      assert.equal(data.detected_at, "before-decision capture", `${mode}: fault detection phase differs`);
      assert(data.browserState?.text?.includes(APPROVAL_CONTENT), `${mode}: populated actual approval request is missing`);
      assert(data.hostEvidence?.files?.some(file => file.path === "notes/raft-supplies-1.md"), `${mode}: fixture host observation is missing`);
      inspectPng(await readFile(resolve(directory, "approval-roundtrip-failure.png")));
      results.push({ mode, rejected: true, cause_retained: true });
    } finally { await browser.close(); }
  }
  return results;
}
