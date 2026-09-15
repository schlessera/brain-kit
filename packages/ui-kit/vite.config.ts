import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Storybook's Vite builder auto-loads this file and merges it into its own
// config, so Tailwind and the React plugin are declared once, here, and no
// `viteFinal` is needed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
