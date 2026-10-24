import express from "express";
import { config } from "./config.js";
import { log } from "./events.js";
import * as twilio from "./twilio.js";
import { router } from "./routes.js";
import { startScheduler } from "./scheduler.js";
import { startWeather } from "./weather.js";
import { startTerminal } from "./terminal.js";

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false })); // Twilio posts forms
app.use(express.json());
app.use(router);

app.listen(config.port, () => {
  log("server_started", { port: config.port, twilio: twilio.enabled, simulate: config.simulate });
  if (!twilio.enabled) console.log(`Twilio not configured: worker calls ring in this terminal. (listening on :${config.port})`);
  else console.log(`Twilio webhooks at ${config.publicUrl}/twilio/* (listening on :${config.port})`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("WARNING: ANTHROPIC_API_KEY is not set. Calls will use the fail-safe line and raise warnings.");
  }
  startWeather();
  startScheduler();
  if (process.stdin.isTTY || process.env.SOL_TERMINAL === "1") startTerminal();
});
