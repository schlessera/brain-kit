import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Storybook's Vite builder auto-loads this file and merges it into its own
// config, so Tailwind and the React plugin are declared once, here, and no
// `viteFinal` is needed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Cross-workspace browser tests must share the renderer's React instance.
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    // The transcript integration story imports these through ui-react. Bundle
    // them before the browser tests start so discovery cannot reload a play.
    include: ["react", "react-dom", "react-dom/client", "react-dom/server", "zustand", "zustand/vanilla", "zustand/react/shallow", "zod", "saxes", "lucide-react", "mermaid", "clsx", "framer-motion", "react-markdown", "rehype-highlight", "remark-gfm", "tailwind-merge"],
  },
});
