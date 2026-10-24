import { EventEmitter } from "node:events";
import fs from "node:fs";

// Everything that happens goes on the bus (the terminal simulator listens)
// and into an append-only audit log.
export const bus = new EventEmitter();

const LOG = process.env.SOL_LOG || new URL("../data/events.jsonl", import.meta.url);
if (!process.env.SOL_LOG) fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });

export function log(type, data = {}) {
  const entry = { at: new Date().toISOString(), type, ...data };
  fs.appendFile(LOG, JSON.stringify(entry) + "\n", () => {});
  bus.emit("log", entry);
}
