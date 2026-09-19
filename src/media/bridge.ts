import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import { logEvent } from "../lib/log.js";
import type { CanonicalAssetReference } from "../contracts/media.js";
import type {
  DriveAuthContext,
  DriveAuthResult,
  DriveReadResult,
  DriveStatus,
  DriveWriteInput,
  DriveWriteResult,
  SovereignDrive,
} from "./drive.js";
import { mapDriveHttpError, type DriveErrorClass } from "./errors.js";
import { mintDriveJwt } from "./jwt.js";

const ALLOWED_PREFIXES = ["image/", "audio/", "video/", "application/pdf"];

export type DriveBridgeOptions = {
  fetchFn?: typeof fetch;
};

export class SovereignDriveMediaBridge implements SovereignDrive {
  private readVerified = false;
  private writeVerified = false;

  constructor(
    private readonly config: AppConfig,
    private readonly options: DriveBridgeOptions = {},
  ) {}

  status(): DriveStatus {
    const configured = Boolean(this.config.sovereignDriveUrl);
    return {
      available: configured,
      read: configured,
      write: configured,
      configured,
      runtimeReadVerified: this.readVerified,
      runtimeWriteVerified: this.writeVerified,
    };
  }

  async createWriteIntent(input: DriveAuthContext): Promise<DriveAuthResult> {
    const token = this.tokenFor(input);
    if (!token) return { ok: false, error: "drive_auth_failed", detail: "Sovereign Drive write requires an actor proof." };
    if (!this.config.sovereignDriveUrl) return { ok: false, error: "drive_unavailable", detail: "Sovereign Drive is not configured." };
    return { ok: true, tenantId: input.tenantId };
  }

  async authorizeRead(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult> {
    const resolved = await this.resolveCanonicalAsset(input);
    return resolved;
  }

  async resolveCanonicalAsset(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult> {
    const token = this.tokenFor(input);
    if (!token) return { ok: false, error: "drive_auth_failed", detail: "Sovereign Drive read requires an actor proof." };
    const result = await this.request("GET", `/v1/storage/asset/${encodeURIComponent(input.assetId)}`, token);
    if (!result.ok) return { ok: false, error: result.error, detail: result.detail };
    this.readVerified = true;
    return { ok: true, tenantId: input.tenantId };
  }

  async verifyOwnership(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult> {
    return this.authorizeRead(input);
  }

  async readAsset(input: DriveAuthContext & { assetId: string }): Promise<DriveReadResult> {
    const auth = await this.authorizeRead(input);
    if (!auth.ok) return auth;
    const token = this.tokenFor(input);
    if (!token) return { ok: false, error: "drive_auth_failed", detail: "Sovereign Drive read requires an actor proof." };
    const result = await this.requestBytes("GET", `/v1/storage/asset/${encodeURIComponent(input.assetId)}/content`, token);
    if (!result.ok) return { ok: false, error: result.error, detail: result.detail };
    if (!isAllowedMediaType(result.mimeType)) {
      return { ok: false, error: "drive_invalid_media", detail: "Unsupported Drive media type." };
    }
    if (result.bytes.length > this.config.maxImageBytes) {
      return { ok: false, error: "drive_quota", detail: "Drive asset exceeds Digi AI media size limit." };
    }
    this.readVerified = true;
    return {
      ok: true,
      assetId: input.assetId,
      mimeType: result.mimeType,
      bytes: result.bytes,
      hash: result.hash,
      tenantId: input.tenantId,
    };
  }

  async persistGeneratedMedia(input: DriveWriteInput): Promise<DriveWriteResult> {
    return this.writeGenerated(input);
  }

  async writeGenerated(input: DriveWriteInput): Promise<DriveWriteResult> {
    const intent = await this.createWriteIntent(input);
    if (!intent.ok) {
      const error = intent.error === "media_access_denied" || intent.error === "not_found" ? "drive_access_denied" : intent.error;
      return { ok: false, error, detail: intent.detail };
    }
    const token = this.tokenFor(input);
    if (!token) return { ok: false, error: "drive_auth_failed", detail: "Sovereign Drive write requires an actor proof." };
    if (!isAllowedMediaType(input.mimeType)) {
      return { ok: false, error: "drive_invalid_media", detail: "Unsupported generated media type." };
    }
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.filename || "generated.bin");
    form.set("contentType", input.mimeType);
    form.set("filename", input.filename || "generated.bin");
    form.set("private", "true");
    form.set(
      "metadata",
      JSON.stringify({
        generated: input.generated === false ? "false" : "true",
        mediaType: input.mediaType || input.mimeType,
        capability: input.capability || "",
        provider: input.providerId || "",
        model: input.modelId || "",
        applicationId: input.callerId,
        actorTrustId: input.actorTrustId,
        sourceAssetIds: (input.sourceAssetIds ?? []).join(","),
        executionRef: input.executionRef || "",
        createdAt: new Date().toISOString(),
        contentHash: digest,
        byteSize: String(input.bytes.length),
        width: input.width != null ? String(input.width) : "",
        height: input.height != null ? String(input.height) : "",
        durationSeconds: input.durationSeconds != null ? String(input.durationSeconds) : "",
        sampleRate: input.sampleRate != null ? String(input.sampleRate) : "",
        channels: input.channels != null ? String(input.channels) : "",
      }),
    );
    const result = await this.request("POST", "/v1/storage/upload", token, form);
    if (!result.ok) return { ok: false, error: result.error === "drive_read_failed" ? "drive_write_failed" : result.error, detail: result.detail };
    const body = result.body as { assetId?: string; tenantId?: string; hash?: string; sizeBytes?: number };
    if (!body.assetId) return { ok: false, error: "drive_write_failed", detail: "Sovereign Drive did not return a canonical asset reference." };
    if (body.hash && body.hash !== digest) {
      return { ok: false, error: "drive_integrity_failed", detail: "Drive checksum did not match uploaded bytes." };
    }
    this.writeVerified = true;
    const reference: CanonicalAssetReference = {
      assetId: body.assetId,
      system: "sovereign-drive",
      tenantId: body.tenantId,
    };
    return { ok: true, reference, hash: body.hash ?? digest, sizeBytes: body.sizeBytes ?? input.bytes.length };
  }

  private tokenFor(input: DriveAuthContext): string | undefined {
    if (this.config.sovereignDriveJwtSecret && input.actorTrustId && input.tenantId) {
      return mintDriveJwt({
        secret: this.config.sovereignDriveJwtSecret,
        issuer: this.config.sovereignDriveJwtIssuer,
        audience: this.config.sovereignDriveJwtAudience,
        userId: input.actorTrustId,
        tenantId: input.tenantId,
        ttlSeconds: 300,
      });
    }
    if (input.accessToken?.trim()) return input.accessToken.trim();
    return undefined;
  }

  private async request(
    method: string,
    path: string,
    token: string,
    body?: FormData,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: DriveErrorClass; detail: string }> {
    const base = this.config.sovereignDriveUrl;
    if (!base) return { ok: false, error: "drive_unavailable", detail: "Sovereign Drive is not configured." };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.sovereignDriveTimeoutMs);
    try {
      const res = await (this.options.fetchFn ?? fetch)(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logEvent("drive_http_error", { status: res.status, path, error: mapDriveHttpError(res.status, text) });
        return { ok: false, error: mapDriveHttpError(res.status, text), detail: publicDriveDetail(res.status) };
      }
      const json = (await res.json().catch(() => ({}))) as unknown;
      return { ok: true, body: json };
    } catch (err) {
      const timeout = err instanceof Error && err.name === "AbortError";
      return { ok: false, error: timeout ? "drive_timeout" : "drive_unavailable", detail: timeout ? "Sovereign Drive timed out." : "Sovereign Drive is unreachable." };
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestBytes(
    method: string,
    path: string,
    token: string,
  ): Promise<{ ok: true; bytes: Buffer; mimeType: string; hash?: string } | { ok: false; error: DriveErrorClass; detail: string }> {
    const base = this.config.sovereignDriveUrl;
    if (!base) return { ok: false, error: "drive_unavailable", detail: "Sovereign Drive is not configured." };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.sovereignDriveTimeoutMs);
    try {
      const res = await (this.options.fetchFn ?? fetch)(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
        redirect: "manual",
      });
      if (!res.ok) {
        logEvent("drive_http_error", { status: res.status, path, error: mapDriveHttpError(res.status) });
        return { ok: false, error: mapDriveHttpError(res.status), detail: publicDriveDetail(res.status) };
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      return {
        ok: true,
        bytes,
        mimeType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim(),
        hash: res.headers.get("x-content-hash") ?? undefined,
      };
    } catch (err) {
      const timeout = err instanceof Error && err.name === "AbortError";
      return { ok: false, error: timeout ? "drive_timeout" : "drive_read_failed", detail: timeout ? "Sovereign Drive timed out." : "Sovereign Drive read failed." };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAllowedMediaType(mimeType: string) {
  return ALLOWED_PREFIXES.some((prefix) => mimeType === prefix || mimeType.startsWith(prefix));
}

function publicDriveDetail(status: number) {
  if (status === 401) return "Sovereign Drive did not accept the actor proof.";
  if (status === 403) return "Actor is not authorized for that asset.";
  if (status === 404) return "Asset was not found.";
  return "Sovereign Drive could not complete that media operation.";
}
