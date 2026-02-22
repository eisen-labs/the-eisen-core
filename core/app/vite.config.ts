import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: ".",
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      allow: [
        ".",
        path.resolve(__dirname, "../ui"),
      ],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
  },
});
