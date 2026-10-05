import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync } from "fs";
import { createHash } from "crypto";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

// The on-device engine (llama.cpp as WebAssembly, ~9 MB) is not bundled into the
// app; it is downloaded on first use from the npm CDN and checked against this hash.
const wllamaPkg = JSON.parse(readFileSync("node_modules/@wllama/wllama/package.json", "utf-8"));
const wllamaWasm = readFileSync("node_modules/@wllama/wllama/esm/wasm/wllama.wasm");

// KaTeX ships every font as woff2 + woff + ttf; WebViews only need woff2.
const katexWoff2Only = {
  name: "katex-woff2-only",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!/katex(\.min)?\.css/.test(id)) return null;
    return code.replace(/,\s*url\([^)]+\.woff\)\s*format\("woff"\)/g, "").replace(/,\s*url\([^)]+\.ttf\)\s*format\("truetype"\)/g, "");
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [katexWoff2Only, solid()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __WLLAMA_VERSION__: JSON.stringify(wllamaPkg.version),
    __WLLAMA_WASM_SHA256__: JSON.stringify(createHash("sha256").update(wllamaWasm).digest("hex")),
    __WLLAMA_WASM_SIZE__: String(wllamaWasm.length),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
