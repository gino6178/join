// The town's clock. Dates and times in Join ("2026-10-31", "21:30") are in the town's local time, and the code does its
// arithmetic with the process's local time, so the process runs in the town's time zone (world.json timeZone), whatever
// the machine's own zone is. Imported first by the server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = process.env.WORLD_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/world.json");
try { const zone = JSON.parse(fs.readFileSync(file, "utf8")).timeZone; if (zone && !process.env.TZ) process.env.TZ = zone; } catch {}
