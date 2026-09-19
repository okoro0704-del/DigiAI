import type { AppConfig } from "../config.js";
import { FileBackedStore, MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import type { DigiAiStore } from "./types.js";

export type { DigiAiStore } from "./types.js";
export { MemoryStore, FileBackedStore } from "./memory.js";
export { PostgresStore } from "./postgres.js";

export function createStore(config: AppConfig): DigiAiStore {
  if (config.databaseUrl) return new PostgresStore(config.databaseUrl);
  if (config.dataDir) return new FileBackedStore(config.dataDir);
  return new MemoryStore();
}
