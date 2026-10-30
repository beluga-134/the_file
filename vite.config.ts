import { defineConfig } from "vite";

// 端口与 qq_codex (1420) 错开，允许两者同时 dev
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "../qq_codex/**"],
    },
  },
});
