export const DRIVE_ERRORS = [
  "drive_unavailable",
  "drive_auth_failed",
  "drive_access_denied",
  "drive_asset_not_found",
  "drive_read_failed",
  "drive_write_failed",
  "drive_invalid_media",
  "drive_quota",
  "drive_timeout",
  "drive_integrity_failed",
] as const;

export type DriveErrorClass = (typeof DRIVE_ERRORS)[number];

export function mapDriveHttpError(status: number, message = ""): DriveErrorClass {
  const text = message.toLowerCase();
  if (status === 401) return "drive_auth_failed";
  if (status === 403) return "drive_access_denied";
  if (status === 404) return "drive_asset_not_found";
  if (status === 413 || text.includes("too large") || text.includes("quota")) return "drive_quota";
  if (status === 415 || text.includes("invalid") || text.includes("unsupported")) return "drive_invalid_media";
  if (status === 408 || status === 504) return "drive_timeout";
  if (status >= 500) return "drive_unavailable";
  return status >= 400 ? "drive_write_failed" : "drive_unavailable";
}

export function toPublicDriveError(error: DriveErrorClass): { status: number; code: string; message: string } {
  if (error === "drive_auth_failed") return { status: 401, code: "drive_auth_failed", message: "Sovereign Drive did not accept the actor proof." };
  if (error === "drive_access_denied") return { status: 403, code: "media_access_denied", message: "Actor is not authorized for that asset." };
  if (error === "drive_asset_not_found") return { status: 404, code: "not_found", message: "Asset was not found." };
  if (error === "drive_quota") return { status: 429, code: "media_too_large", message: "Sovereign Drive rejected the media size or quota." };
  if (error === "drive_invalid_media") return { status: 400, code: "invalid_media", message: "Sovereign Drive rejected the media as invalid." };
  if (error === "drive_timeout") return { status: 504, code: "provider_unavailable", message: "Sovereign Drive timed out." };
  return { status: 502, code: "persistence_failed", message: "Sovereign Drive could not complete that media operation." };
}
