import type { AppConfig } from "../config.js";
import type { EconomicsMode } from "../contracts/credits.js";

export function parseEconomicsMode(raw: string): EconomicsMode {
  const value = raw.trim().toLowerCase();
  if (value === "disabled" || value === "observe" || value === "enforce") return value;
  return "observe";
}

export function economicsMode(config: AppConfig): EconomicsMode {
  return config.economicsMode;
}

export function enforcementEnabled(config: AppConfig): boolean {
  return config.economicsMode === "enforce";
}

export function accountingEnabled(config: AppConfig): boolean {
  return config.economicsMode !== "disabled";
}
