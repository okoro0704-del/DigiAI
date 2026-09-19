import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
if (config.isProd && config.callers.length === 0) {
  throw new Error("DIGI_AI_CALLERS is required in production.");
}
if (config.isProd && !config.databaseUrl) {
  throw new Error("DATABASE_URL is required in production for the Digi AI usage ledger.");
}

const app = buildApp(config);
if (app.store.ready) await app.store.ready();
await app.listen({ port: config.port, host: "0.0.0.0" });
