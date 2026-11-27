import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Порт 5174. Запросы /api проксируются на API (:3000), поэтому Mini App работает и через публичный туннель (scripts/tunnel.command).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174, host: true, allowedHosts: true,
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
