/// <reference types="@vitest/browser-playwright" />
import type { BrowserCommand } from "vitest/node";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const conversationDiagnosticIdentity: BrowserCommand<[], string> = async () => JSON.parse(process.env.BRAIN_PROOF_CASE_CHECKOUT ?? "{}").sha ?? "a".repeat(40);
type Fixture = { label: "smooth" | "cut"; provider: number[]; mix: number[]; metadata: object };
/** Output-only deterministic fixtures; never writes captured data into the public tree. */
export const conversationDiagnosticExport: BrowserCommand<[Fixture], string> = async (_ctx, fixture) => {
  if (!["smooth", "cut"].includes(fixture.label) || fixture.provider.length > 100000 || fixture.mix.length > 400000 || JSON.stringify(fixture.metadata).length > 100000) throw new Error("Fixture export bound exceeded");
  const directory = mkdtempSync(join(tmpdir(), `odysseus-tail-${fixture.label}-`));
  writeFileSync(join(directory, "provider.wav"), new Uint8Array(fixture.provider));
  writeFileSync(join(directory, "mix.wav"), new Uint8Array(fixture.mix));
  writeFileSync(join(directory, "metadata.json"), JSON.stringify(fixture.metadata, null, 2));
  return directory;
};
declare module "vitest/browser" { interface BrowserCommands { conversationDiagnosticIdentity: () => Promise<string>; conversationDiagnosticExport: (fixture: Fixture) => Promise<string> } }
