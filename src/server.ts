import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
if (config.isProd && config.callers.length === 0) {
  throw new Error("DIGI_AI_CALLERS is required in production.");
}

const app = buildApp(config);
await app.listen({ port: config.port, host: "0.0.0.0" });
