import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  // Static-asset base. "/" for standalone; when mounted behind FusionSearch, set
  // VITE_API_BASE (e.g. "/email") at build time so index.html references
  // /email/assets/... instead of /assets/....
  base: process.env.VITE_API_BASE ? `${process.env.VITE_API_BASE.replace(/\/$/, "")}/` : "/",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000"
    }
  }
});
