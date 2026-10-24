import { defineConfig } from "vite";
import { resolve } from "node:path";
import { copyFileSync } from "node:fs";

export default defineConfig({
  base: "./",
  // Nothing from the environment is ever compiled in: no VITE_ variables, no keys.
  envPrefix: "PRIVATEBIT_BUILD_NEVER_",
  publicDir: "public",
  plugins: [
    (() => {
      let outDir = resolve(__dirname, "dist");
      return {
        name: "copy-manifest",
        configResolved(cfg: { build: { outDir: string } }) {
          outDir = resolve(__dirname, cfg.build.outDir);
        },
        closeBundle() {
          copyFileSync(resolve(__dirname, "manifest.json"), resolve(outDir, "manifest.json"));
        },
      };
    })(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        full: resolve(__dirname, "full.html"),
        background: resolve(__dirname, "src/background.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
