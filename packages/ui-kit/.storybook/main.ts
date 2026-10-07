import { defineMain } from "@storybook/react-vite/node";

export default defineMain({
  framework: "@storybook/react-vite",
  // D32 requires native light-dark() evaluation at each using subtree.
  // The builder discards vite.config.ts's build options except target, so this
  // belongs in viteFinal. Older CSS targets lower tokens into variables that
  // resolve at :root and break the Paper frame in a dark document.
  viteFinal: async (config) => ({
    ...config,
    build: { ...config.build, cssTarget: ["chrome123", "firefox128", "safari17.5"] },
  }),
  // stories/ mirrors src/, so a component and its stories line up without
  // stories living inside the directory that ships. src/ may not import a
  // devDependency (tests/dependency-edges.test.ts), and every story imports
  // `storybook/test`.
  stories: ["../stories/**/*.mdx", "../stories/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-themes",
    "@storybook/addon-vitest",
    // Serves an MCP endpoint at localhost:6006/mcp while `storybook dev` runs,
    // so an agent reuses the real components instead of inventing markup, and
    // can run and self-heal its own interaction and a11y tests (D11).
    "@storybook/addon-mcp",
  ],
  // Required by addon-mcp: the manifest is what lets an agent discover the
  // components and their props.
  features: { componentsManifest: true },
  // Storybook's dev server answers `403 Invalid host` to any Host header but
  // localhost, and the UI reports that as "Unable to reach server" — which
  // is what you get opening it through the machine's hostname, its LAN
  // address or a forwarded URL. Dev only; the static build has no server.
  core: { allowedHosts: true },
});
