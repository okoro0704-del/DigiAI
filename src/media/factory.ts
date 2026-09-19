import type { AppConfig } from "../config.js";
import { SovereignDriveMediaBridge } from "./bridge.js";
import { UnboundDrive, type SovereignDrive } from "./drive.js";

export function createDrive(config: AppConfig): SovereignDrive {
  if (config.sovereignDriveUrl) return new SovereignDriveMediaBridge(config);
  return new UnboundDrive();
}
