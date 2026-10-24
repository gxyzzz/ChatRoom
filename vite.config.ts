/** Vite/Vue development and production build configuration for the embedded WebUI. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";

export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
    {
      name: "pdfjs-font-resources",
      generateBundle() {
        for (const directory of ["cmaps", "standard_fonts"]) {
          const source = join("node_modules", "pdfjs-dist", directory);
          for (const name of readdirSync(source)) {
            if (!/\.(bcmap|pfb|ttf)$/.test(name)) continue;
            this.emitFile({
              type: "asset",
              fileName: `assets/pdfjs/${directory}/${name}`,
              source: readFileSync(join(source, name)),
            });
          }
        }
      },
    },
  ],
  resolve: {
    conditions: [
      "chatroom-source",
      "module",
      "browser",
      "development|production",
    ],
  },
  root: "src/plugins/web/ui",
  publicDir: "public",
  build: {
    outDir: "../../../../dist/web",
    emptyOutDir: false,
  },
  server: {
    proxy: {
      "^/api(?:/|$)": "http://127.0.0.1:8765",
      "^/mcp(?:/|$)": "http://127.0.0.1:8765",
    },
  },
});
