import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Storybook's Vite builder auto-loads this file and merges it into its own
// config, so Tailwind and the React plugin are declared once, here.
// Storybook-specific build options live in .storybook/main.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Cross-workspace browser tests must share the renderer's React instance.
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    // Bundle ui-react dependencies before browser tests start. In particular,
    // late PDF discovery can invalidate React URLs while a lazy graph imports
    // into an executing test (#1897). Dedupe alone cannot preserve that identity.
    include: ["react", "react-dom", "react-dom/client", "react-dom/server", "zustand", "zustand/vanilla", "zustand/react/shallow", "zod", "saxes", "lucide-react", "mermaid", "clsx", "framer-motion", "react-markdown", "rehype-highlight", "remark-gfm", "tailwind-merge", "pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.min.mjs"],
  },
});
