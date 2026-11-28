import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// /api → локальный API (нужно, чтобы открыть сайт по одной публичной ссылке через туннель)
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, allowedHosts: true, proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } } },
});
