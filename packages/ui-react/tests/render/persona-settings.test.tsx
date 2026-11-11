// The Persona group of Settings › Voice (#3617), mounted against a root whose
// persona routes the test answers. No microphone, no network; the mounted
// routes and a real browser are persona-settings-runtime.test.ts.
import { unregisterPersonaSettingsDom } from "./persona-settings-dom.js";

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ConversationProfile, LivePersona, LivePersonaCreateRequest, LivePersonaStatus, LivePersonaSummary, LivePersonaUpdateRequest } from "@schlessera/brain-ui-sdk/protocol";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ApiRequestError, type BrainApi } from "../../src/lib/api-client.js";
import { PersonaSettings } from "../../src/components/settings/persona-settings.js";

const roots: BrainUiRoot[] = [];
afterEach(() => { cleanup(); for (const root of roots.splice(0)) root.dispose(); });
afterAll(unregisterPersonaSettingsDom);

const GPT: ConversationProfile = {
  providerId: "gpt-live", capabilities: {} as ConversationProfile["capabilities"], disclosure: { voiceService: "GPT-Live", destinations: ["Fixture."] },
  voices: [{ id: "marin", label: "marin" }, { id: "cedar", label: "cedar" }], defaultVoice: "marin", personaInstructionBytes: 2_000,
};
const STANDARD: LivePersona = { id: "standard", name: "Standard", voices: { "gpt-live": "marin" }, instructionBytes: 0, revision: "builtin", builtIn: true, instructions: "" };
const steward = (instructions = "Calm, brief, plain words."): LivePersona => ({ id: "ithaca-steward", name: "Ithaca steward", voices: { "gpt-live": "cedar", "harbor-live": "Lantern" },
  instructionBytes: new TextEncoder().encode(instructions).byteLength, revision: `r-${instructions.length}`, instructions });
const summary = ({ instructions: _text, ...rest }: LivePersona): LivePersonaSummary => rest;

function personaRoot(options: { forbidden?: boolean; broken?: boolean } = {}) {
  const files = new Map<string, LivePersona>([["ithaca-steward", steward()]]);
  const broken: LivePersonaSummary = { id: "broken", name: "broken", voices: {}, instructionBytes: 0, revision: "x", invalid: "schema" };
  const selection = { value: "standard", revision: 0 };
  const calls: string[] = [];
  const status = (): LivePersonaStatus => ({ selected: selection.value, selectedMissing: false, selectedInvalid: false, persona: summary(files.get(selection.value) ?? STANDARD),
    personaRef: { id: selection.value, revision: (files.get(selection.value) ?? STANDARD).revision }, providers: {} });
  const conflict = { next: null as LivePersona | null, stale: false };
  const api = {
    livePersonas: async () => {
      if (options.forbidden) throw new ApiRequestError("HTTP 403", 403);
      return { personas: [summary(STANDARD), ...(options.broken === false ? [] : [broken]), ...[...files.values()].map(summary)] };
    },
    voiceSettings: async () => ({ persona: { ...selection }, livePersona: status() }),
    livePersona: async (id: string) => files.get(id) ?? STANDARD,
    saveLivePersonaSelection: async (value: string, revision: number) => {
      calls.push(`select ${value}@${revision}`);
      if (conflict.stale) { conflict.stale = false; selection.revision++; throw new ApiRequestError("LIVE_PERSONA_CHANGED", 409); }
      selection.value = value; selection.revision++;
      return { persona: { ...selection }, livePersona: status() };
    },
    createLivePersona: async (request: LivePersonaCreateRequest) => {
      calls.push(`create ${request.id ?? request.name}`);
      const id = request.id ?? "penelope";
      const created = { ...steward(request.instructions), id, name: request.name, voices: request.voices };
      files.set(id, created);
      return created;
    },
    updateLivePersona: async (id: string, request: LivePersonaUpdateRequest) => {
      calls.push(`update ${id}@${request.baseRevision}`);
      if (conflict.next) { files.set(id, conflict.next); conflict.next = null; throw new ApiRequestError("PERSONA_CHANGED", 409); }
      const updated = { ...steward(request.instructions), name: request.name, voices: request.voices };
      files.set(id, updated);
      return updated;
    },
    deleteLivePersona: async (id: string, base: string) => { calls.push(`delete ${id}@${base}`); files.delete(id); if (selection.value === id) { selection.value = "standard"; selection.revision++; } },
  } as unknown as BrainApi;
  const root = createBrainUiRoot({ storage: null, api });
  root.connection.conversation.state.setState({ conversationProfile: GPT });
  roots.push(root);
  return { root, files, selection, calls, conflict };
}

async function mount(root: BrainUiRoot) {
  const view = render(<BrainUiProvider root={root}><PersonaSettings active /></BrainUiProvider>);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return view;
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
/** React's input polyfill under happy-dom reads a change through the focused field's key events. */
function type(field: Element, value: string) {
  act(() => (field as HTMLElement).focus());
  fireEvent.input(field, { target: { value } });
  fireEvent.keyUp(field, { key: "a" });
}

test("lists Standard first, each persona's voices and bytes, and unusable files as unselectable", async () => {
  const t = personaRoot();
  const view = await mount(t.root);
  const rows = [...view.container.querySelectorAll("[data-persona-row]")].map(row => row.getAttribute("data-persona-row"));
  expect(rows).toEqual(["standard", "broken", "ithaca-steward"]);
  expect(view.getByText("built in · default voices")).toBeTruthy();
  expect(view.getByText("cedar · 25 bytes")).toBeTruthy();
  expect(view.getByText("Can't be used: it was written for a different version")).toBeTruthy();
  const radio = (id: string) => view.container.querySelector(`[data-persona-row="${id}"] input[type=radio]`) as HTMLInputElement;
  expect(radio("broken").disabled).toBe(true);
  expect(radio("standard").checked).toBe(true);
  expect(view.getByRole("radiogroup", { name: "Persona" })).toBeTruthy();
  expect(view.getByRole("button", { name: "More for Ithaca steward" })).toBeTruthy();
  expect(view.container.querySelector("[data-persona-empty]")).toBeNull();
});

test("only Standard shows the empty line", async () => {
  const t = personaRoot({ broken: false });
  t.files.clear();
  const view = await mount(t.root);
  expect(view.getByText("Only Standard so far. Personas you add appear here.")).toBeTruthy();
});

test("picking a persona saves the selection at its revision; a stale save reloads the latest", async () => {
  const t = personaRoot();
  const view = await mount(t.root);
  fireEvent.click(view.container.querySelector('[data-persona-row="ithaca-steward"] input')!);
  await settle();
  expect(t.calls).toEqual(["select ithaca-steward@0"]);
  t.conflict.stale = true;
  fireEvent.click(view.container.querySelector('[data-persona-row="standard"] input')!);
  await settle(); await settle();
  expect(view.container.querySelector("[data-persona-notice]")!.textContent).toBe("Changed on another device. Showing the latest.");
});

test("the editor counts exact bytes per service, validates and never renders instructions as markup", async () => {
  const t = personaRoot();
  const view = await mount(t.root);
  fireEvent.click(view.getByText("+ New persona"));
  await settle();
  const instructions = view.container.querySelector("[data-persona-instructions]") as HTMLTextAreaElement;
  type(instructions, '<img src="x" data-sirens="">Sing é');
  expect(view.container.querySelector("[data-persona-count]")!.textContent).toBe("35 / 2,000 bytes for GPT-Live");
  expect(view.container.querySelector("img[data-sirens]")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await settle();
  expect(view.getByText("Give the persona a name (up to 40 characters).")).toBeTruthy();
  expect(t.calls).toEqual([]);
  type(instructions, "é".repeat(1_001));
  expect(view.container.querySelector("[data-persona-count]")!.textContent).toBe("2,002 / 2,000 bytes for GPT-Live (too long)");
  type(view.container.querySelector("[data-persona-name]")!, "Penelope");
  fireEvent.change(view.container.querySelector('[data-persona-voice="gpt-live"]')!, { target: { value: "cedar" } });
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await settle(); await settle();
  // Too long for GPT-Live is still a valid persona; Start, not Save, refuses it there.
  expect(t.calls).toEqual(["create Penelope"]);
  expect(t.files.get("penelope")!.voices).toEqual({ "gpt-live": "cedar" });
});

test("an edit keeps voices for services this host doesn't run, and a conflict keeps the user's text", async () => {
  const t = personaRoot();
  const view = await mount(t.root);
  fireEvent.click(view.getByRole("button", { name: "Edit Ithaca steward" }));
  await settle();
  expect(view.container.querySelector('[data-persona-elsewhere="harbor-live"]')!.textContent).toContain("Lantern");
  const instructions = view.container.querySelector("[data-persona-instructions]") as HTMLTextAreaElement;
  type(instructions, "Mine: brisk.");
  t.conflict.next = steward("Theirs: slow.");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await settle(); await settle();
  expect(view.container.querySelector("[data-persona-conflict]")).toBeTruthy();
  expect(instructions.value).toBe("Mine: brisk.");
  fireEvent.click(view.getByText("Show the newer version"));
  await settle();
  expect((view.container.querySelector("[data-persona-instructions]") as HTMLTextAreaElement).value).toBe("Theirs: slow.");
  type(view.container.querySelector("[data-persona-instructions]")!, "Merged.");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await settle(); await settle();
  expect(t.calls.at(-1)).toBe(`update ithaca-steward@${steward("Theirs: slow.").revision}`);
  expect(t.files.get("ithaca-steward")!.voices["harbor-live"]).toBe("Lantern");
});

test("deleting the selected persona says new conversations use Standard", async () => {
  const t = personaRoot();
  t.selection.value = "ithaca-steward";
  const view = await mount(t.root);
  fireEvent.click(view.getByRole("button", { name: "More for Ithaca steward" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Delete" }));
  const dialog = view.getByRole("alertdialog");
  expect(dialog.textContent).toContain("Delete “Ithaca steward”?");
  expect(dialog.textContent).toContain("It's the selected persona. New conversations will use Standard. A conversation already running keeps it until it ends.");
  fireEvent.click(view.getByRole("button", { name: "Delete" }));
  await settle(); await settle();
  expect(t.calls).toEqual([`delete ithaca-steward@${steward().revision}`]);
  expect(view.container.querySelector('[data-persona-row="ithaca-steward"]')).toBeNull();
});

test("a refused read says only the owner can change personas", async () => {
  const t = personaRoot({ forbidden: true });
  const view = await mount(t.root);
  expect(view.getByText("Only the owner can see and change personas.")).toBeTruthy();
  expect(view.container.querySelector("[data-persona-row]")).toBeNull();
});
