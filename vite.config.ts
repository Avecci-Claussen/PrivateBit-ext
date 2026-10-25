import { defineConfig } from "vite";
import { resolve } from "node:path";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { buildSync } from "esbuild";

export default defineConfig(({ mode }) => {
  // Private test build only: the key is read from the environment here and never written to the tree.
  const privateKey = mode === "private" ? (process.env.UNISAT_API_KEY ?? "").trim() : "";
  if (mode === "private" && !privateKey) throw new Error("build:private needs UNISAT_API_KEY in the environment");
  return {
  base: "./",
  define: { __PB_PRIVATE_UNISAT__: mode === "private" ? JSON.stringify(privateKey) : "undefined" },
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
          // Page provider and content script: classic scripts with fixed names, no imports.
          for (const name of ["inpage", "content"]) {
            buildSync({
              entryPoints: [resolve(__dirname, `src/dapp/${name}.ts`)],
              outfile: resolve(outDir, `${name}.js`),
              bundle: true,
              format: "iife",
              target: "chrome111",
              minify: true,
              legalComments: "none",
            });
          }
          if (mode === "private") {
            // Make the private build easy to tell apart in chrome://extensions.
            const m = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));
            m.name = `${m.name} (private test)`;
            writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(m, null, 2));
          }
        },
      };
    })(),
  ],
  build: {
    outDir: mode === "private" ? "dist-private" : "dist",
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
};
});
