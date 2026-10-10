/** Inline fixtures prove the gate's rules; the real tree proves its coverage. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanRoot, scanSource } from "../scripts/check-raw-buttons.ts";

const ROOT = resolve(import.meta.dir, "..");
const FILE = "packages/ui-react/src/fixture.tsx";
const scan = (text: string) => scanSource(FILE, text);

describe("raw buttons gate", () => {
  test("an unmarked button fails with its location and migration advice", () => {
    expect(scan('const C = () => (\n  <button type="button">Run</button>\n);')).toEqual([{
      file: FILE, line: 2, column: 3, kind: "missing-marker",
      message: "raw <button> — use Button, IconButton or TextButton from " +
        "@schlessera/brain-ui-kit, or mark it: // raw-button: <code> — <why>",
    }]);
  });

  for (const code of ["row", "select", "surface", "canvas", "kit", "api", "dev"]) {
    test(`${code} markers pass in line and block comments`, () => {
      expect(scan(`const C = () => <button
        // raw-button: ${code} — composite entry needs its own content
        type="button">Run</button>;`)).toEqual([]);
      expect(scan(`const C = () => <button /* raw-button: ${code} - composite entry needs its own content */ />;`)).toEqual([]);
    });
  }

  test("an unknown code fails and lists the valid codes", () => {
    const findings = scan('const C = () => <button /* raw-button: mystery — composite entry needs its own content */ />;');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("unknown-code");
    expect(findings[0]!.message).toContain("'mystery'");
    expect(findings[0]!.message).toContain("row, select, surface, canvas, kit, api, dev");
  });

  test("a reason shorter than twelve characters fails", () => {
    for (const reason of ["short", "12345678901", "12345678901   ", ""]) {
      expect(scan(`const C = () => <button /* raw-button: row — ${reason} */ type="button" />;`)
        .map(f => f.kind)).toEqual(["missing-marker"]);
    }
    expect(scan('const C = () => <button /* raw-button: row — 123456789012 */ />;')).toEqual([]);
  });

  test("a malformed separator or duplicate marker fails", () => {
    expect(scan('const C = () => <button /* raw-button: row : composite content */ />;')
      .map(f => f.kind)).toEqual(["missing-marker"]);
    expect(scan(`const C = () => <button
      // raw-button: row — composite content
      /* raw-button: row — composite content */ />;`).map(f => f.kind)).toEqual(["missing-marker"]);
    expect(scan('const C = () => <button /* raw-button: row — composite content; raw-button: row — composite content */ />;')
      .map(f => f.kind)).toEqual(["missing-marker"]);
  });

  test("orphan markers fail outside the button opening tag", () => {
    for (const text of [
      "// raw-button: row — composite content\nconst C = () => <Button />;",
      "const C = () => <div /* raw-button: row — composite content */ />;",
      "const C = () => <div>{/* raw-button: row — composite content */}</div>;",
      "const C = () => <Button />;\n/* raw-button: row — composite content */",
      "/* raw-button: row — composite content */",
    ]) {
      expect(scan(text).map(f => f.kind)).toEqual(["orphan-marker"]);
    }
    expect(scan(`const C = () => <button /* raw-button: row — composite content */>
      {/* raw-button: row — stale child marker */}
    </button>;`).map(f => f.kind)).toEqual(["orphan-marker"]);
  });

  test("a button inside a JSDoc comment or a string does not fail", () => {
    expect(scan(`/** Example: <button type="button">Run</button> */
      const example = '<button type="button">Run</button>';
      const template = \`<button type="button">Run</button>\`;
      const C = () => <Button />;`)).toEqual([]);
  });

  test("marker text in strings and JSX text is not a comment", () => {
    expect(scan(`const example = "// raw-button: row — composite content";
      const template = \`/* raw-button: row — composite content */\`;
      const C = () => <div>// raw-button: row — ordinary JSX text</div>;`)).toEqual([]);
    expect(scan('const C = () => <button title="raw-button: row — composite content" />;')
      .map(f => f.kind)).toEqual(["missing-marker"]);
  });

  test("scanRoot fails closed on an empty glob and scans only ui-react TSX", () => {
    const root = mkdtempSync(join(tmpdir(), "raw-buttons-gate-"));
    try {
      expect(() => scanRoot(root)).toThrow("the gate checked nothing");
      mkdirSync(join(root, "packages/ui-kit/src"), { recursive: true });
      writeFileSync(join(root, "packages/ui-kit/src/button.tsx"), "const C = () => <button />;");
      expect(() => scanRoot(root)).toThrow("the gate checked nothing");
      mkdirSync(join(root, "packages/ui-react/src/nested"), { recursive: true });
      writeFileSync(join(root, "packages/ui-react/src/nested/button.tsx"), "const C = () => <button />;");
      const findings = scanRoot(root);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.file).toBe("packages/ui-react/src/nested/button.tsx");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real tree passes", () => {
    expect(scanRoot(ROOT).map(f => `${f.file}:${f.line}:${f.column} ${f.message}`)).toEqual([]);
  });
});
