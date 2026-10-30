import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
// The gateway's token (VITE_AGENT_TOKEN in .env.local) is for the club's own machine running `npm run dev`: a build
// would carry it to wherever the build is published, so a build with it set stops (ALLOW_TOKEN_IN_BUILD=1 for a build
// that stays on this machine).
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, path.dirname(fileURLToPath(import.meta.url)), "VITE_");
  if (command === "build" && env.VITE_AGENT_TOKEN && process.env.ALLOW_TOKEN_IN_BUILD !== "1")
    throw new Error("VITE_AGENT_TOKEN is set: this build would publish the gateway's token. Build without it, or set ALLOW_TOKEN_IN_BUILD=1 for a build that stays on this machine.");
  return { plugins: [react()] };
});
