import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `vite build --mode singlefile` inlines everything into one HTML file: used to
// publish a shareable, static preview of the prototype.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "singlefile" ? [viteSingleFile()] : [])],
  build: {
    outDir: mode === "singlefile" ? "dist-singlefile" : "dist",
    target: "es2022",
    // The prototype ships as one bundle; production code-splits each module route (React.lazy).
    chunkSizeWarningLimit: 800,
  },
  server: { port: 5173 },
}));
