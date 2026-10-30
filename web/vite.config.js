import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// In development the website runs on Vite and the API on the Join server (api/, port 8790).
const api = process.env.JOIN_API || "http://localhost:8790";
export default defineConfig({
  plugins: [react()],
  server: { proxy: Object.fromEntries(["/api", "/mcp", "/paypal", "/mock-paypal", "/a2a", "/.well-known"].map((p) => [p, { target: api, changeOrigin: false }])) },
});
