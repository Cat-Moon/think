import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  server: {
    port: Number(process.env.THINK_WEB_PORT) || 5173,
    strictPort: true,
    // THINK_API_PORT：服务端端口（默认 5174），与 THINK_PORT 对应
    proxy: { "/api": `http://127.0.0.1:${process.env.THINK_API_PORT || 5174}` },
  },
  build: { outDir: "../../dist", emptyOutDir: true },
  test: { root: ".", include: ["src/**/*.test.ts"], setupFiles: ["src/test-setup.ts"] },
});
