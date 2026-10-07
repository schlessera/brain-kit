/**
 * Minimal ambient declaration for the stylesheet import in
 * `.storybook/preview.ts`.
 *
 * It lives under `src/` rather than next to the file that needs it because
 * that is what the repo-wide `tsc --noEmit` program globs — a triple-slash
 * reference from the preview would work too, but the oxlint gate rejects
 * those, and rightly.
 *
 * `vite/client` would also supply this, at the cost of dragging every Vite
 * global — `import.meta.env` included — into a program that typechecks all
 * fourteen packages at once. This declares exactly what is needed.
 */
declare module "*.css";

/** Shipped consumer CSS, scoped within the integration preview. */
declare module "*.css?raw" { const text: string; export default text; }
