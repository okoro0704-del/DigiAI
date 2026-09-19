import type { CreditBalance, CreditLedgerEntry, CreditReservation } from "../contracts/credits.js";
import { addUnits, assertUnits, clampNonNegative, subUnits } from "./units.js";

export function deriveCreditBalance(input: {
  accountId: string;
  entries: CreditLedgerEntry[];
  reservations: CreditReservation[];
}): CreditBalance {
  let posted = 0;
  for (const entry of input.entries) {
    if (entry.kind === "GRANT") posted = addUnits(posted, entry.units);
    else if (entry.kind === "ADJUSTMENT") posted = addUnits(posted, entry.units);
    else if (entry.kind === "CONSUME" || entry.kind === "EXPIRY") posted = subUnits(posted, entry.units);
  }
  let reserved = 0;
  for (const row of input.reservations) {
    if (row.status === "held" || row.status === "observe") {
      reserved = addUnits(reserved, clampNonNegative(subUnits(row.reservedUnits, addUnits(row.consumedUnits, row.releasedUnits))));
    }
  }
  return {
    accountId: input.accountId,
    postedUnits: assertUnits(posted),
    reservedUnits: reserved,
    availableUnits: clampNonNegative(subUnits(posted, reserved)),
  };
}

export function creditCursor(entry: CreditLedgerEntry): string {
  return `${entry.createdAt}|${entry.entryId}`;
}

export function parseCreditCursor(cursor?: string): { createdAt: string; entryId: string } | null {
  if (!cursor) return null;
  const idx = cursor.indexOf("|");
  if (idx <= 0) return null;
  return { createdAt: cursor.slice(0, idx), entryId: cursor.slice(idx + 1) };
}
