import type { DigiAiUnits } from "../contracts/credits.js";
import { DigiAiError } from "../lib/http.js";

/**
 * Internal precision:
 * 1 displayed Digi AI credit = 1,000,000 Digi AI Units (micro-units).
 * Display conversion is not a retail price. All balances are integers.
 */
export const DIGI_AI_UNIT_SCALE = 1_000_000;
export const DIGI_AI_UNIT_NAME = "DigiAiUnit";

export function assertUnits(value: unknown, label = "units"): DigiAiUnits {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new DigiAiError(400, "invalid_units", `${label} must be a safe integer.`);
  }
  return value;
}

export function assertNonNegativeUnits(value: unknown, label = "units"): DigiAiUnits {
  const units = assertUnits(value, label);
  if (units < 0) throw new DigiAiError(400, "invalid_units", `${label} cannot be negative.`);
  return units;
}

export function assertPositiveUnits(value: unknown, label = "units"): DigiAiUnits {
  const units = assertUnits(value, label);
  if (units <= 0) throw new DigiAiError(400, "invalid_units", `${label} must be greater than zero.`);
  return units;
}

export function addUnits(a: DigiAiUnits, b: DigiAiUnits): DigiAiUnits {
  return assertUnits(a + b, "sum");
}

export function subUnits(a: DigiAiUnits, b: DigiAiUnits): DigiAiUnits {
  return assertUnits(a - b, "difference");
}

export function mulUnits(a: DigiAiUnits, b: DigiAiUnits): DigiAiUnits {
  return assertUnits(a * b, "product");
}

/** Integer ceiling of (amount * units) / per. */
export function ceilRatio(amount: DigiAiUnits, units: DigiAiUnits, per: DigiAiUnits): DigiAiUnits {
  const safeAmount = assertNonNegativeUnits(amount, "amount");
  const safeUnits = assertPositiveUnits(units, "rate.units");
  const safePer = assertPositiveUnits(per, "rate.per");
  return assertUnits(Math.trunc((safeAmount * safeUnits + safePer - 1) / safePer), "ceilRatio");
}

export function maxUnits(a: DigiAiUnits, b: DigiAiUnits): DigiAiUnits {
  return a >= b ? a : b;
}

export function minUnits(a: DigiAiUnits, b: DigiAiUnits): DigiAiUnits {
  return a <= b ? a : b;
}

export function clampNonNegative(value: DigiAiUnits): DigiAiUnits {
  return value < 0 ? 0 : assertUnits(value);
}
